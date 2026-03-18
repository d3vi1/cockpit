/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Build a @patternfly/react-topology Model from UDisks2 client data.
 *
 * Uses a proper hierarchical layer model with containment groups:
 *
 *   Layer 0: Physical Disks (raw block devices, loop devices)
 *   Layer 1: Multipath / RAID (dm-multipath, mdraid)
 *   Layer 2: Partitions
 *   Layer 3: Storage Pool Members (LVM PVs, ZFS members, BTRFS members)
 *   Layer 4: Storage Pools / Volume Groups (LVM VGs, ZFS Pools)
 *   Layer 5: Logical Volumes / Datasets (LVM LVs, ZFS datasets/zvols)
 *   Layer 6: Consumers (filesystems, swap, LUKS)
 *
 * Group nodes are used for containment (e.g. an mdraid array group
 * encloses its member disks; an LVM VG group encloses its PVs; a ZFS
 * pool group encloses vdev sub-groups which enclose member disks).
 * Edges are only created for cross-layer relationships that are NOT
 * already expressed by containment.
 */

import cockpit from "cockpit";
import {
    EdgeStyle,
    NodeStatus,
} from "@patternfly/react-topology";
import {
    decode_filename, block_short_name,
    drive_name, mdraid_name, fmt_size,
} from "../utils.js";

const _ = cockpit.gettext;

/* ── constants ───────────────────────────────────────────────────── */

const LEAF_WIDTH = 120;
const LEAF_HEIGHT = 50;
const GROUP_PADDING = 20;

/* ── helpers ─────────────────────────────────────────────────────── */

/**
 * Safe string conversion for fmt_size.  In newer Cockpit versions,
 * cockpit.format_bytes() may return an array or object instead of a
 * plain string.  Coerce the result so it is always a display string.
 */
function safe_fmt_size(bytes) {
    const result = fmt_size(bytes);
    if (result == null) return "";
    if (typeof result === "string") return result;
    if (Array.isArray(result)) return result.join(" ");
    return String(result);
}

/**
 * Safely coerce a value to a string for use as a node label or badge.
 * Prevents [object Object] from appearing in the graph.
 */
function safeLabel(val) {
    if (val == null) return "";
    if (typeof val === "string") return val;
    if (typeof val === "number") return String(val);
    if (Array.isArray(val)) return val.join(" ");
    if (typeof val === "object" && val.v !== undefined) return String(val.v);
    return String(val);
}

/**
 * Build a human-readable label: "name (size)" or just "name".
 */
function labelWithSize(name, sizeBytes) {
    const n = safeLabel(name);
    if (sizeBytes != null && sizeBytes > 0) {
        const s = safe_fmt_size(sizeBytes);
        if (s) return `${n} (${s})`;
    }
    return n;
}

/** Determine health status for a drive */
function driveStatus(drive, client) {
    if (!drive)
        return NodeStatus.default;
    const ata = drive.path && client.drives_ata?.[drive.path];
    if (ata && ata.SmartFailing)
        return NodeStatus.danger;
    return NodeStatus.default;
}

function mdraidStatus(mdraid) {
    if (!mdraid)
        return NodeStatus.default;
    if (mdraid.Degraded > 0)
        return NodeStatus.warning;
    return NodeStatus.success;
}

function zfsPoolStatus(pool) {
    if (!pool)
        return NodeStatus.default;
    const state = pool.State;
    if (state === "ONLINE")
        return NodeStatus.success;
    if (state === "DEGRADED")
        return NodeStatus.warning;
    if (state === "FAULTED" || state === "UNAVAIL")
        return NodeStatus.danger;
    return NodeStatus.default;
}

/** Create a leaf node entry */
function makeNode(id, nodeType, label, opts) {
    return {
        id,
        type: 'node',
        label: safeLabel(label) || id,
        width: opts?.width || LEAF_WIDTH,
        height: opts?.height || LEAF_HEIGHT,
        data: {
            nodeType,
            badge: safeLabel(opts?.badge),
            badgeColor: opts?.badgeColor,
            path: opts?.path,
            size: opts?.size,
            status: opts?.status || NodeStatus.default,
            ...(opts?.extra || {}),
        },
        ...(opts?.status ? { status: opts.status } : {}),
    };
}

/** Create a group node entry */
function makeGroup(id, nodeType, label, children, opts) {
    return {
        id,
        type: 'group',
        label: safeLabel(label) || id,
        group: true,
        children,
        style: { padding: opts?.padding ?? GROUP_PADDING },
        data: {
            nodeType,
            badge: safeLabel(opts?.badge),
            status: opts?.status || NodeStatus.default,
            path: opts?.path,
            ...(opts?.extra || {}),
        },
        ...(opts?.status ? { status: opts.status } : {}),
    };
}

/** Create an edge entry */
function makeEdge(source, target, opts) {
    return {
        id: `edge-${source}-${target}`,
        type: 'edge',
        source,
        target,
        edgeStyle: opts?.edgeStyle || EdgeStyle.default,
    };
}

/* ── main builder ────────────────────────────────────────────────── */

/**
 * Build a Model compatible with @patternfly/react-topology.
 *
 * Uses containment groups instead of edges for "is part of" relationships.
 * Edges are only used for cross-layer connections (e.g. VG -> LV,
 * LV -> filesystem).
 *
 * @param {object} client  - the storaged client singleton
 * @param {object|null} asyncData - optional async-fetched data (ZFS vdevs, datasets)
 * @returns {{ graph, nodes: Array, edges: Array }}
 */
export function buildTopologyModel(client, asyncData) {
    const nodes = [];
    const edges = [];
    const groups = [];

    // Track block -> node-id so we can wire cross-layer edges
    const blockNodeMap = new Map();   // block.path -> nodeId
    const driveNodeMap = new Map();   // drive.path -> nodeId
    const vgNodeMap = new Map();      // vgroup.path -> nodeId
    const mdraidNodeMap = new Map();  // mdraid.path -> nodeId
    const zfsPoolNodeMap = new Map(); // zfs pool.path -> nodeId
    const lvolNodeMap = new Map();    // lvol.path -> nodeId

    // Track which blocks are already claimed by a group (to avoid duplication)
    const claimedBlocks = new Set();  // block.path set

    /* ================================================================
     * Phase 1: Physical Disks
     *
     * Raw block devices backed by physical drives.
     * Also includes loop devices (blocks with Drive == "/").
     * ================================================================ */

    // 1a. Drive-backed block devices
    for (const path in client.drives) {
        const drive = client.drives[path];
        const block = client.drives_block[path];
        if (!block)
            continue;

        const name = drive_name(drive) || block_short_name(block);
        const label = labelWithSize(name, drive.Size);
        const nodeId = `disk-${block.path}`;

        nodes.push(makeNode(nodeId, 'disk', label, {
            status: driveStatus(drive, client),
            badge: safeLabel(drive.ConnectionBus || drive.Media || "Disk"),
            path: block.path,
            size: drive.Size,
        }));

        driveNodeMap.set(path, nodeId);
        blockNodeMap.set(block.path, nodeId);
    }

    // 1b. Loop devices and other top-level blocks without a drive
    for (const path in client.blocks) {
        const block = client.blocks[path];

        // Skip blocks that already have a drive node
        if (blockNodeMap.has(path))
            continue;

        // Skip partition children — they are handled in Phase 2
        if (client.blocks_part[path])
            continue;

        // Skip blocks that are cleartext counterparts of encrypted devices
        if (block.CryptoBackingDevice && block.CryptoBackingDevice !== "/")
            continue;

        // Skip mdraid result blocks
        if (block.MDRaid && block.MDRaid !== "/")
            continue;

        // Skip LVM2 LV blocks — they come from LVs
        if (client.blocks_lvm2[path])
            continue;

        // Only include blocks with no parent drive (loop devices, etc.)
        if (block.Drive && block.Drive !== "/")
            continue;

        const devName = block_short_name(block);
        const label = labelWithSize(devName, block.Size);
        const nodeId = `disk-${path}`;

        const isLoop = decode_filename(block.Device).startsWith("/dev/loop");
        nodes.push(makeNode(nodeId, 'disk', label, {
            badge: isLoop ? "Loop" : "Block",
            path,
            size: block.Size,
        }));

        blockNodeMap.set(path, nodeId);
    }

    /* ================================================================
     * Phase 2: Partitions
     *
     * Partition tables create child partitions on a parent disk.
     * Each partition becomes a node with an edge from the parent disk.
     * ================================================================ */

    for (const path in client.blocks_ptable) {
        const partitions = client.blocks_partitions[path] || [];
        for (const part of partitions) {
            const partBlock = client.blocks[part.path];
            if (!partBlock)
                continue;

            const partName = block_short_name(partBlock);
            const label = labelWithSize(partName, part.Size);
            const partNodeId = `partition-${part.path}`;

            nodes.push(makeNode(partNodeId, 'partition', label, {
                badge: safeLabel(part.Type || "Part"),
                path: part.path,
                size: part.Size,
            }));

            blockNodeMap.set(partBlock.path, partNodeId);

            // Edge: parent disk -> partition
            const parentNodeId = blockNodeMap.get(path);
            if (parentNodeId) {
                edges.push(makeEdge(parentNodeId, partNodeId));
            }
        }
    }

    /* ================================================================
     * Phase 3: MDRAID Arrays (as containment groups)
     *
     * An mdraid array is a group that contains its member disk nodes.
     * The resulting array block device gets a node ID so downstream
     * consumers (partitions, LVM, filesystems) can connect to it.
     * ================================================================ */

    for (const path in client.mdraids) {
        const mdraid = client.mdraids[path];
        const raidBlock = client.mdraids_block[path];

        const name = mdraid_name(mdraid) || (raidBlock ? block_short_name(raidBlock) : path);
        const level = mdraid.Level ? mdraid.Level.toUpperCase() : "";
        const label = labelWithSize(name, mdraid.Size);

        // Collect member node IDs
        const members = client.mdraids_members[path] || [];
        const memberNodeIds = [];
        for (const member of members) {
            let memberNodeId = blockNodeMap.get(member.path);
            if (!memberNodeId) {
                // Create a node for this member if it does not exist yet
                const memberName = block_short_name(member);
                const memberLabel = labelWithSize(memberName, member.Size);
                memberNodeId = `disk-${member.path}`;
                nodes.push(makeNode(memberNodeId, 'disk', memberLabel, {
                    badge: "Disk",
                    path: member.path,
                    size: member.Size,
                }));
                blockNodeMap.set(member.path, memberNodeId);
            }
            memberNodeIds.push(memberNodeId);
            claimedBlocks.add(member.path);
        }

        const groupId = `mdraid-group-${path}`;

        if (memberNodeIds.length > 0) {
            // Create the mdraid as a group containing its member disks
            groups.push(makeGroup(groupId, 'mdraid', `${label} [${level}]`, memberNodeIds, {
                status: mdraidStatus(mdraid),
                badge: level,
                path,
            }));
        } else {
            // No members found — create as a plain node
            nodes.push(makeNode(groupId, 'mdraid', label, {
                status: mdraidStatus(mdraid),
                badge: level,
                path,
                size: mdraid.Size,
            }));
        }

        mdraidNodeMap.set(path, groupId);
        if (raidBlock) {
            blockNodeMap.set(raidBlock.path, groupId);
        }
    }

    /* ================================================================
     * Phase 4: LVM2 Volume Groups (as containment groups)
     *
     * A VG is a group that contains its PV (Physical Volume) nodes.
     * PVs that correspond to existing block nodes get claimed into
     * the group; PVs with no existing node get new nodes created.
     * ================================================================ */

    for (const path in client.vgroups) {
        const vgroup = client.vgroups[path];
        const pvols = client.vgroups_pvols[path] || [];
        const pvNodeIds = [];

        for (const pvol of pvols) {
            const pvBlock = client.blocks[pvol.path];
            if (!pvBlock)
                continue;

            let pvNodeId = blockNodeMap.get(pvol.path);
            if (!pvNodeId) {
                // PV block not previously mapped — create a node for it
                const pvName = block_short_name(pvBlock);
                const pvLabel = labelWithSize(pvName, pvBlock.Size);
                pvNodeId = `pv-${pvol.path}`;
                nodes.push(makeNode(pvNodeId, 'lvm_pv', pvLabel, {
                    badge: _("PV"),
                    path: pvol.path,
                    size: pvBlock.Size,
                }));
                blockNodeMap.set(pvol.path, pvNodeId);
            }
            pvNodeIds.push(pvNodeId);
            claimedBlocks.add(pvol.path);
        }

        const groupId = `vg-group-${path}`;
        const label = labelWithSize(vgroup.Name, vgroup.Size);

        if (pvNodeIds.length > 0) {
            groups.push(makeGroup(groupId, 'lvm_vg', label, pvNodeIds, {
                badge: _("VG"),
                path,
            }));
        } else {
            // Empty VG — show as a plain node
            nodes.push(makeNode(groupId, 'lvm_vg', label, {
                badge: _("VG"),
                path,
                size: vgroup.Size,
            }));
        }

        vgNodeMap.set(path, groupId);

        // Edge: if PV's source disk is NOT inside this group (e.g. a partition
        // whose parent disk is outside), create an edge from disk -> VG group.
        // This handles cases like: disk -> partition -> PV (inside VG group),
        // where we need the partition->disk edge but the PV is inside the VG.
        // Those edges were already created in Phase 2 (disk -> partition).
    }

    /* ================================================================
     * Phase 5: LVM2 Logical Volumes
     *
     * LVs are children of their VG (via edge, not containment, since
     * LVs are on a different layer than PVs).
     * ================================================================ */

    for (const path in client.lvols) {
        const lvol = client.lvols[path];
        if (!lvol.VolumeGroup || lvol.VolumeGroup === "/")
            continue;

        const lvBlock = client.lvols_block[path];
        const name = lvol.Name;
        const label = labelWithSize(name, lvol.Size);

        let badge = "";
        if (lvol.Type === "pool")
            badge = _("Thin Pool");
        else if (lvol.ThinPool && lvol.ThinPool !== "/")
            badge = _("Thin");
        else
            badge = _("LV");

        const nodeId = `lv-${path}`;

        nodes.push(makeNode(nodeId, 'lvm_lv', label, {
            badge,
            path,
            size: lvol.Size,
        }));

        lvolNodeMap.set(path, nodeId);
        if (lvBlock)
            blockNodeMap.set(lvBlock.path, nodeId);

        // Edge: VG -> LV (cross-layer)
        const vgNodeId = vgNodeMap.get(lvol.VolumeGroup);
        if (vgNodeId) {
            edges.push(makeEdge(vgNodeId, nodeId));
        }

        // Edge: Thin Pool -> Thin LV
        if (lvol.ThinPool && lvol.ThinPool !== "/") {
            const poolNodeId = lvolNodeMap.get(lvol.ThinPool);
            if (poolNodeId) {
                edges.push(makeEdge(poolNodeId, nodeId, { edgeStyle: EdgeStyle.dashed }));
            }
        }
    }

    /* ================================================================
     * Phase 6: ZFS Pools (as containment groups with vdev sub-groups)
     *
     * A ZFS pool is a group containing vdev sub-groups.
     * Each vdev sub-group contains its member disk nodes.
     * If async vdev topology data is available, we build the full
     * pool -> vdev -> disk hierarchy. Otherwise, we fall back to
     * the simpler blocks_zfs membership data.
     * ================================================================ */

    for (const path in client.zfs_pools) {
        const pool = client.zfs_pools[path];
        const poolGroupId = `zfs-pool-${path}`;
        const poolLabel = labelWithSize(pool.Name, Number(pool.Size));
        const poolStatus = zfsPoolStatus(pool);

        // Collect pool member blocks from client.blocks_zfs
        const memberBlockPaths = [];
        for (const bpath in client.blocks_zfs) {
            const zfsBlock = client.blocks_zfs[bpath];
            const block = client.blocks[bpath];
            if (!block)
                continue;

            // Match by pool path or by label
            let matches = false;
            if (zfsBlock.Pool && zfsBlock.Pool !== "/" && zfsBlock.Pool === path) {
                matches = true;
            } else {
                const label = block.IdLabel || "";
                if (label === pool.Name)
                    matches = true;
            }

            if (matches)
                memberBlockPaths.push(bpath);
        }

        // Check if we have async vdev topology data for this pool
        const vdevData = asyncData?.zfsVdevs?.find(v => v.poolPath === path);

        if (vdevData && Array.isArray(vdevData.vdevs) && vdevData.vdevs.length > 0) {
            // Build full pool -> vdev -> disk hierarchy
            const poolChildren = [];

            const processVdevs = (vdevList, depth) => {
                if (!Array.isArray(vdevList))
                    return;

                for (let i = 0; i < vdevList.length; i++) {
                    const vdev = vdevList[i];
                    const vdevType = safeLabel(vdev.type?.v || vdev.type || "");
                    const vdevState = safeLabel(vdev.state?.v || vdev.state || "");

                    if (vdevType === "disk" || vdevType === "file") {
                        // Leaf vdev — find or create the disk node
                        const devPath = vdev.path?.v || vdev.path || "";
                        if (devPath) {
                            const slashBlock = client.slashdevs_block?.[devPath];
                            if (slashBlock) {
                                let diskNodeId = blockNodeMap.get(slashBlock.path);
                                if (!diskNodeId) {
                                    const dName = block_short_name(slashBlock);
                                    const dLabel = labelWithSize(dName, slashBlock.Size);
                                    diskNodeId = `disk-${slashBlock.path}`;
                                    nodes.push(makeNode(diskNodeId, 'disk', dLabel, {
                                        badge: "Disk",
                                        path: slashBlock.path,
                                        size: slashBlock.Size,
                                    }));
                                    blockNodeMap.set(slashBlock.path, diskNodeId);
                                }
                                claimedBlocks.add(slashBlock.path);
                                // Return the node ID so parent vdev group can include it
                                poolChildren.push(diskNodeId);
                            }
                        }
                    } else {
                        // Group vdev (mirror, raidz, spare, cache, log, etc.)
                        const vdevChildren = vdev.children?.v || vdev.children || [];
                        const childNodeIds = [];

                        if (Array.isArray(vdevChildren)) {
                            for (let j = 0; j < vdevChildren.length; j++) {
                                const child = vdevChildren[j];
                                const childType = safeLabel(child.type?.v || child.type || "");
                                const childPath = child.path?.v || child.path || "";

                                if (childType === "disk" || childType === "file") {
                                    if (childPath) {
                                        const slashBlock = client.slashdevs_block?.[childPath];
                                        if (slashBlock) {
                                            let diskNodeId = blockNodeMap.get(slashBlock.path);
                                            if (!diskNodeId) {
                                                const dName = block_short_name(slashBlock);
                                                const dLabel = labelWithSize(dName, slashBlock.Size);
                                                diskNodeId = `disk-${slashBlock.path}`;
                                                nodes.push(makeNode(diskNodeId, 'disk', dLabel, {
                                                    badge: "Disk",
                                                    path: slashBlock.path,
                                                    size: slashBlock.Size,
                                                }));
                                                blockNodeMap.set(slashBlock.path, diskNodeId);
                                            }
                                            childNodeIds.push(diskNodeId);
                                            claimedBlocks.add(slashBlock.path);
                                        }
                                    }
                                } else {
                                    // Nested group vdev — recurse
                                    // (rare, but possible with nested mirrors, etc.)
                                    const nestedIds = [];
                                    const nestedChildren = child.children?.v || child.children || [];
                                    if (Array.isArray(nestedChildren)) {
                                        for (const nc of nestedChildren) {
                                            const ncPath = nc.path?.v || nc.path || "";
                                            if (ncPath) {
                                                const slashBlock = client.slashdevs_block?.[ncPath];
                                                if (slashBlock) {
                                                    let diskNodeId = blockNodeMap.get(slashBlock.path);
                                                    if (!diskNodeId) {
                                                        const dName = block_short_name(slashBlock);
                                                        const dLabel = labelWithSize(dName, slashBlock.Size);
                                                        diskNodeId = `disk-${slashBlock.path}`;
                                                        nodes.push(makeNode(diskNodeId, 'disk', dLabel, {
                                                            badge: "Disk",
                                                            path: slashBlock.path,
                                                            size: slashBlock.Size,
                                                        }));
                                                        blockNodeMap.set(slashBlock.path, diskNodeId);
                                                    }
                                                    nestedIds.push(diskNodeId);
                                                    claimedBlocks.add(slashBlock.path);
                                                }
                                            }
                                        }
                                    }
                                    if (nestedIds.length > 0) {
                                        const nestedGroupId = `zfs-vdev-${path}-${childType}-${j}`;
                                        groups.push(makeGroup(nestedGroupId, 'zfs_vdev', childType, nestedIds, {
                                            badge: childType,
                                        }));
                                        childNodeIds.push(nestedGroupId);
                                    }
                                }
                            }
                        }

                        if (childNodeIds.length > 0) {
                            const vdevGroupId = `zfs-vdev-${path}-${vdevType}-${i}`;
                            let vdevStatus = NodeStatus.default;
                            if (vdevState === "ONLINE") vdevStatus = NodeStatus.success;
                            else if (vdevState === "DEGRADED") vdevStatus = NodeStatus.warning;
                            else if (vdevState === "FAULTED" || vdevState === "UNAVAIL") vdevStatus = NodeStatus.danger;

                            groups.push(makeGroup(vdevGroupId, 'zfs_vdev', vdevType, childNodeIds, {
                                badge: vdevType,
                                status: vdevStatus,
                            }));
                            poolChildren.push(vdevGroupId);
                        }
                    }
                }
            };

            processVdevs(vdevData.vdevs, 0);

            if (poolChildren.length > 0) {
                groups.push(makeGroup(poolGroupId, 'zfs_pool', poolLabel, poolChildren, {
                    status: poolStatus,
                    badge: safe_fmt_size(Number(pool.Size)),
                    path,
                }));
            } else {
                // No vdev children resolved — fall back to plain node
                nodes.push(makeNode(poolGroupId, 'zfs_pool', poolLabel, {
                    status: poolStatus,
                    badge: safe_fmt_size(Number(pool.Size)),
                    path,
                    size: Number(pool.Size),
                }));
            }
        } else {
            // No async vdev data — use blocks_zfs membership to build a flat group
            const memberNodeIds = [];
            for (const bpath of memberBlockPaths) {
                const block = client.blocks[bpath];
                if (!block)
                    continue;

                let memberNodeId = blockNodeMap.get(bpath);
                if (!memberNodeId) {
                    const name = block_short_name(block);
                    const label = labelWithSize(name, block.Size);
                    memberNodeId = `disk-${bpath}`;
                    nodes.push(makeNode(memberNodeId, 'zfs_member', label, {
                        badge: _("ZFS"),
                        path: bpath,
                        size: block.Size,
                    }));
                    blockNodeMap.set(bpath, memberNodeId);
                }
                memberNodeIds.push(memberNodeId);
                claimedBlocks.add(bpath);
            }

            if (memberNodeIds.length > 0) {
                groups.push(makeGroup(poolGroupId, 'zfs_pool', poolLabel, memberNodeIds, {
                    status: poolStatus,
                    badge: safe_fmt_size(Number(pool.Size)),
                    path,
                }));
            } else {
                nodes.push(makeNode(poolGroupId, 'zfs_pool', poolLabel, {
                    status: poolStatus,
                    badge: safe_fmt_size(Number(pool.Size)),
                    path,
                    size: Number(pool.Size),
                }));
            }
        }

        zfsPoolNodeMap.set(path, poolGroupId);
    }

    /* ================================================================
     * Phase 7: ZFS Datasets, Zvols, and Snapshots
     *
     * If async dataset data is available, create nodes for each dataset
     * with an edge from the pool group to the dataset.
     * ================================================================ */

    if (asyncData?.zfsDatasets) {
        for (const { poolPath, datasets } of asyncData.zfsDatasets) {
            const poolNodeId = zfsPoolNodeMap.get(poolPath);
            if (!poolNodeId || !Array.isArray(datasets))
                continue;

            for (const ds of datasets) {
                const dsName = ds.name || "";
                // Skip the root dataset (same name as pool)
                const poolObj = client.zfs_pools[poolPath];
                if (poolObj && dsName === poolObj.Name)
                    continue;

                const dsType = ds.type || "filesystem";
                const dsUsed = ds.used || 0;
                const dsMounted = ds.mounted || false;

                let badge = dsType;
                if (dsType === "filesystem") badge = "FS";
                else if (dsType === "volume") badge = "Zvol";
                else if (dsType === "snapshot") badge = "Snap";

                let status = NodeStatus.default;
                if (dsType === "filesystem" && dsMounted)
                    status = NodeStatus.success;

                const dsNodeId = `zfs-ds-${poolPath}-${dsName}`;
                const label = labelWithSize(dsName, dsUsed);

                nodes.push(makeNode(dsNodeId, 'zfs_dataset', label, {
                    badge,
                    status,
                    path: poolPath,
                    extra: {
                        datasetName: dsName,
                        datasetType: dsType,
                        mountpoint: ds.mountpoint || "",
                    },
                }));

                // Edge: pool -> dataset
                edges.push(makeEdge(poolNodeId, dsNodeId));
            }
        }
    }

    /* ================================================================
     * Phase 8: Encrypted (LUKS) layers
     *
     * LUKS sits between a block device and its cleartext consumer.
     * Edge: parent block -> encrypted node.
     * The cleartext block is remapped so downstream consumers
     * (filesystems, etc.) attach to the encrypted node.
     * ================================================================ */

    for (const path in client.blocks_crypto) {
        const block = client.blocks[path];
        if (!block)
            continue;

        const cleartextBlock = client.blocks_cleartext[path];
        const parentNodeId = blockNodeMap.get(path);
        if (!parentNodeId)
            continue;

        const nodeId = `encrypted-${path}`;
        const isUnlocked = !!cleartextBlock;

        nodes.push(makeNode(nodeId, 'encrypted', _("Encrypted"), {
            status: isUnlocked ? NodeStatus.success : NodeStatus.warning,
            badge: isUnlocked ? _("Unlocked") : _("Locked"),
            path,
        }));

        edges.push(makeEdge(parentNodeId, nodeId));

        // Map the cleartext block to the encrypted node so downstream
        // (filesystem, LVM, etc.) can attach to it
        if (cleartextBlock) {
            blockNodeMap.set(cleartextBlock.path, nodeId);
        }
    }

    /* ================================================================
     * Phase 9: Filesystems
     *
     * Edge: parent block node -> filesystem node.
     * ================================================================ */

    for (const path in client.blocks_fsys) {
        const fsys = client.blocks_fsys[path];
        const block = client.blocks[path];
        if (!block)
            continue;

        const mountPoints = fsys.MountPoints
                .map(mp => safeLabel(decode_filename(mp)))
                .filter(Boolean);
        if (mountPoints.length === 0)
            continue;

        const parentNodeId = blockNodeMap.get(path);
        if (!parentNodeId)
            continue;

        // Skip if this is a ZFS-managed filesystem (handled in Phase 7)
        if (block.IdType === "zfs_member")
            continue;

        const mountLabel = mountPoints[0];
        const nodeId = `fs-${path}`;

        nodes.push(makeNode(nodeId, 'filesystem', mountLabel, {
            status: NodeStatus.success,
            badge: block.IdType || _("fs"),
            path,
        }));

        edges.push(makeEdge(parentNodeId, nodeId, { edgeStyle: EdgeStyle.dashed }));
    }

    /* ================================================================
     * Phase 10: Swap
     * ================================================================ */

    for (const path in client.blocks_swap) {
        const block = client.blocks[path];
        if (!block)
            continue;

        const parentNodeId = blockNodeMap.get(path);
        if (!parentNodeId)
            continue;

        const nodeId = `swap-${path}`;
        const label = labelWithSize(_("Swap"), block.Size);

        nodes.push(makeNode(nodeId, 'swap', label, {
            badge: safe_fmt_size(block.Size),
            path,
            size: block.Size,
        }));

        edges.push(makeEdge(parentNodeId, nodeId, { edgeStyle: EdgeStyle.dashed }));
    }

    /* ================================================================
     * Assemble the final model
     *
     * Groups and leaf nodes are combined into the nodes array.
     * The layout is Dagre with TB (top-to-bottom) direction, which
     * maps naturally to the storage stack hierarchy.
     * ================================================================ */

    return {
        graph: {
            id: 'storage-topology',
            type: 'graph',
            layout: 'Dagre',
        },
        nodes: [...nodes, ...groups],
        edges,
    };
}

/* ── async data fetcher ──────────────────────────────────────────── */

/**
 * Parse a vdev entry from the GetVdevTopology D-Bus result.
 * Handles both {v: ...} variant-wrapped and raw values.
 */
function parseVdevRaw(v) {
    return {
        path: v.path?.v ?? v.path ?? "",
        type: v.type?.v ?? v.type ?? "",
        state: v.state?.v ?? v.state ?? "UNKNOWN",
        children: v.children?.v
            ? v.children.v.map(parseVdevRaw)
            : (Array.isArray(v.children) ? v.children.map(parseVdevRaw) : null),
    };
}

/**
 * Parse a dataset entry from the ListDatasets D-Bus result.
 */
function parseDatasetRaw(d) {
    return {
        name: d.name?.v || "",
        type: d.type?.v || "filesystem",
        mountpoint: d.mountpoint?.v || "-",
        mounted: d.mounted?.v || false,
        used: Number(d.used?.v || 0),
        available: Number(d.available?.v || 0),
        referenced: Number(d.referenced?.v || 0),
    };
}

/**
 * Fetch async topology data that is not available from D-Bus proxies.
 *
 * Currently fetches:
 *   - ZFS vdev topology for each pool (GetVdevTopology)
 *   - ZFS datasets for each pool (ListDatasets)
 *
 * Uses Promise.allSettled for graceful partial failure.
 *
 * @param {object} client - the storaged client singleton
 * @returns {Promise<{ zfsVdevs: Array, zfsDatasets: Array }>}
 */
export async function fetchAsyncTopologyData(client) {
    const pools = Object.values(client.zfs_pools || {});
    if (pools.length === 0)
        return { zfsVdevs: [], zfsDatasets: [] };

    const [vdevResults, datasetResults] = await Promise.all([
        Promise.allSettled(
            pools.map(pool =>
                client.zfs_pool_call(pool.path, "GetVdevTopology", [{}])
                        .then(r => ({
                            poolPath: pool.path,
                            poolName: pool.Name,
                            vdevs: Array.isArray(r[0]) ? r[0].map(parseVdevRaw) : r[0],
                        }))
            )
        ),
        Promise.allSettled(
            pools.map(pool =>
                client.zfs_pool_call(pool.path, "ListDatasets", [{ type: { t: 's', v: 'all' } }])
                        .then(r => ({
                            poolPath: pool.path,
                            poolName: pool.Name,
                            datasets: Array.isArray(r[0]) ? r[0].map(parseDatasetRaw) : [],
                        }))
            )
        ),
    ]);

    return {
        zfsVdevs: vdevResults
                .filter(r => r.status === 'fulfilled')
                .map(r => r.value),
        zfsDatasets: datasetResults
                .filter(r => r.status === 'fulfilled')
                .map(r => r.value),
    };
}
