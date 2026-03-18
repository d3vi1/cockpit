/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Build a @patternfly/react-topology Model from UDisks2 client data.
 */

import cockpit from "cockpit";
import {
    EdgeStyle,
    NodeShape,
    NodeStatus,
} from "@patternfly/react-topology";
import {
    decode_filename, block_short_name,
    drive_name, mdraid_name, fmt_size,
} from "../utils.js";

const _ = cockpit.gettext;

/* ── helpers ─────────────────────────────────────────────────────── */

const NODE_WIDTH = 120;
const NODE_HEIGHT = 65;

let _idCounter = 0;
function uid(prefix) {
    return prefix + "-" + (++_idCounter);
}

function resetIdCounter() {
    _idCounter = 0;
}

/** Determine health status for a node */
function driveStatus(drive) {
    if (!drive)
        return NodeStatus.default;
    const ata = drive.path && drive.client?.drives_ata?.[drive.path];
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

/** Create a node entry for the topology model */
function makeNode(id, type, label, opts) {
    return {
        id,
        type: 'node',
        label: label || id,
        width: opts?.width || NODE_WIDTH,
        height: opts?.height || NODE_HEIGHT,
        shape: opts?.shape || NodeShape.rect,
        status: opts?.status || NodeStatus.default,
        data: {
            nodeType: type,
            badge: opts?.badge,
            badgeColor: opts?.badgeColor,
            path: opts?.path,
            size: opts?.size,
            ...(opts?.extra || {}),
        },
    };
}

/** Create an edge entry for the topology model */
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
 * @param {object} client  – the storaged client singleton
 * @param {object|null} asyncData – optional async-fetched data (e.g. ZFS vdevs)
 * @returns {{ graph, nodes: Array, edges: Array }}
 */
export function buildTopologyModel(client, asyncData) {
    resetIdCounter();

    const nodes = [];
    const edges = [];

    // Track block -> node-id mappings so we can wire edges later
    const blockNodeMap = new Map();    // block.path -> nodeId
    const driveNodeMap = new Map();    // drive.path -> nodeId
    const vgNodeMap = new Map();       // vgroup.path -> nodeId
    const mdraidNodeMap = new Map();   // mdraid.path -> nodeId
    const zfsPoolNodeMap = new Map();  // zfs pool.path -> nodeId
    const lvolNodeMap = new Map();     // lvol.path -> nodeId

    /* ── 1. Drives ───────────────────────────────────────────────── */

    for (const path in client.drives) {
        const drive = client.drives[path];
        const block = client.drives_block[path];
        if (!block)
            continue;

        const name = drive_name(drive) || block_short_name(block);
        const size = drive.Size ? fmt_size(drive.Size) : "";
        const nodeId = `drive-${path}`;

        nodes.push(makeNode(nodeId, 'drive', name, {
            shape: NodeShape.rect,
            status: driveStatus(drive),
            badge: size,
            path,
            size: drive.Size,
        }));

        driveNodeMap.set(path, nodeId);
        blockNodeMap.set(block.path, nodeId);
    }

    /* ── 2. Block devices (partitions and unaffiliated blocks) ──── */

    for (const path in client.blocks_ptable) {
        const ptable = client.blocks_ptable[path];
        const block = client.blocks[path];
        if (!block)
            continue;

        const partitions = client.blocks_partitions[path] || [];
        for (const part of partitions) {
            const partBlock = client.blocks[part.path];
            if (!partBlock)
                continue;

            const partName = block_short_name(partBlock);
            const partSize = fmt_size(part.Size);
            const partNodeId = `partition-${part.path}`;

            nodes.push(makeNode(partNodeId, 'partition', partName, {
                shape: NodeShape.rect,
                badge: partSize,
                path: part.path,
                size: part.Size,
            }));

            blockNodeMap.set(partBlock.path, partNodeId);

            // Edge: drive -> partition (via partition table block)
            const parentNodeId = blockNodeMap.get(path);
            if (parentNodeId) {
                edges.push(makeEdge(parentNodeId, partNodeId));
            }
        }
    }

    /* ── 3. MDRAID arrays ────────────────────────────────────────── */

    for (const path in client.mdraids) {
        const mdraid = client.mdraids[path];
        const raidBlock = client.mdraids_block[path];

        const name = mdraid_name(mdraid) || (raidBlock ? block_short_name(raidBlock) : path);
        const level = mdraid.Level ? mdraid.Level.toUpperCase() : "";
        const nodeId = `mdraid-${path}`;

        nodes.push(makeNode(nodeId, 'mdraid', name, {
            shape: NodeShape.hexagon,
            status: mdraidStatus(mdraid),
            badge: level,
            path,
            size: mdraid.Size,
        }));

        mdraidNodeMap.set(path, nodeId);
        if (raidBlock)
            blockNodeMap.set(raidBlock.path, nodeId);

        // Edges: member blocks -> mdraid
        const members = client.mdraids_members[path] || [];
        for (const member of members) {
            const memberNodeId = blockNodeMap.get(member.path);
            if (memberNodeId) {
                edges.push(makeEdge(memberNodeId, nodeId));
            }
        }
    }

    /* ── 4. LVM2 Volume Groups ───────────────────────────────────── */

    for (const path in client.vgroups) {
        const vgroup = client.vgroups[path];
        const nodeId = `vg-${path}`;

        nodes.push(makeNode(nodeId, 'lvm_vg', vgroup.Name, {
            shape: NodeShape.hexagon,
            status: NodeStatus.default,
            badge: fmt_size(vgroup.Size),
            path,
            size: vgroup.Size,
        }));

        vgNodeMap.set(path, nodeId);

        // Edges: PV blocks -> VG
        const pvols = client.vgroups_pvols[path] || [];
        for (const pvol of pvols) {
            const pvBlock = client.blocks[pvol.path];
            if (!pvBlock)
                continue;

            const pvNodeId = blockNodeMap.get(pvol.path);
            if (pvNodeId) {
                edges.push(makeEdge(pvNodeId, nodeId));
            } else {
                // PV block not yet mapped (e.g. no partition table, bare device)
                const pvName = block_short_name(pvBlock);
                const pvNodeIdNew = `pv-${pvol.path}`;

                nodes.push(makeNode(pvNodeIdNew, 'lvm_pv', pvName, {
                    shape: NodeShape.rect,
                    badge: _("PV"),
                    path: pvol.path,
                }));

                blockNodeMap.set(pvol.path, pvNodeIdNew);
                edges.push(makeEdge(pvNodeIdNew, nodeId));
            }
        }
    }

    /* ── 5. LVM2 Logical Volumes ─────────────────────────────────── */

    for (const path in client.lvols) {
        const lvol = client.lvols[path];
        if (!lvol.VolumeGroup || lvol.VolumeGroup === "/")
            continue;

        const nodeId = `lv-${path}`;
        const lvBlock = client.lvols_block[path];
        const name = lvol.Name;

        let badge = "";
        if (lvol.Type === "pool")
            badge = _("Thin Pool");
        else if (lvol.ThinPool && lvol.ThinPool !== "/")
            badge = _("Thin");
        else
            badge = _("LV");

        nodes.push(makeNode(nodeId, 'lvm_lv', name, {
            shape: NodeShape.rect,
            badge,
            path,
            size: lvol.Size,
        }));

        lvolNodeMap.set(path, nodeId);
        if (lvBlock)
            blockNodeMap.set(lvBlock.path, nodeId);

        // Edge: VG -> LV
        const vgNodeId = vgNodeMap.get(lvol.VolumeGroup);
        if (vgNodeId) {
            edges.push(makeEdge(vgNodeId, nodeId));
        }

        // Thin pool -> thin LV edge
        if (lvol.ThinPool && lvol.ThinPool !== "/") {
            const poolNodeId = lvolNodeMap.get(lvol.ThinPool);
            if (poolNodeId) {
                edges.push(makeEdge(poolNodeId, nodeId, { edgeStyle: EdgeStyle.dashed }));
            }
        }
    }

    /* ── 6. ZFS Pools ────────────────────────────────────────────── */

    for (const path in client.zfs_pools) {
        const pool = client.zfs_pools[path];
        const nodeId = `zfs-pool-${path}`;

        nodes.push(makeNode(nodeId, 'zfs_pool', pool.Name, {
            shape: NodeShape.hexagon,
            status: zfsPoolStatus(pool),
            badge: fmt_size(Number(pool.Size)),
            path,
            size: Number(pool.Size),
        }));

        zfsPoolNodeMap.set(path, nodeId);
    }

    // ZFS pool member blocks
    for (const path in client.blocks_zfs) {
        const zfsBlock = client.blocks_zfs[path];
        const block = client.blocks[path];
        if (!block)
            continue;

        const poolPath = zfsBlock.Pool;
        const poolNodeId = (poolPath && poolPath !== "/") ? zfsPoolNodeMap.get(poolPath) : null;

        // If pool path is "/", try to match by label
        let resolvedPoolNodeId = poolNodeId;
        if (!resolvedPoolNodeId) {
            const label = block.IdLabel || "";
            for (const pp in client.zfs_pools) {
                if (client.zfs_pools[pp].Name === label) {
                    resolvedPoolNodeId = zfsPoolNodeMap.get(pp);
                    break;
                }
            }
        }

        const memberNodeId = blockNodeMap.get(path);
        if (memberNodeId && resolvedPoolNodeId) {
            edges.push(makeEdge(memberNodeId, resolvedPoolNodeId));
        } else if (!memberNodeId && resolvedPoolNodeId) {
            // Create a node for the member block
            const name = block_short_name(block);
            const newNodeId = `zfs-member-${path}`;
            nodes.push(makeNode(newNodeId, 'zfs_member', name, {
                shape: NodeShape.rect,
                badge: _("ZFS"),
                path,
            }));
            blockNodeMap.set(path, newNodeId);
            edges.push(makeEdge(newNodeId, resolvedPoolNodeId));
        }
    }

    // ZFS vdev topology from async data
    if (asyncData?.zfsVdevs) {
        for (const { poolPath, poolName, vdevs } of asyncData.zfsVdevs) {
            const poolNodeId = zfsPoolNodeMap.get(poolPath);
            if (!poolNodeId || !vdevs)
                continue;

            // vdevs is typically an array of vdev objects with children
            const processVdevs = (vdevList, parentId) => {
                if (!Array.isArray(vdevList))
                    return;
                for (const vdev of vdevList) {
                    if (vdev.type === "disk" || vdev.type === "file") {
                        // Leaf vdev — try to find the block node
                        const devPath = vdev.path;
                        if (devPath) {
                            const slashBlock = client.slashdevs_block?.[devPath];
                            if (slashBlock) {
                                const existingNodeId = blockNodeMap.get(slashBlock.path);
                                if (existingNodeId && parentId) {
                                    // Avoid duplicate edges
                                    const edgeId = `edge-${existingNodeId}-${parentId}`;
                                    if (!edges.some(e => e.id === edgeId)) {
                                        edges.push(makeEdge(existingNodeId, parentId));
                                    }
                                }
                            }
                        }
                    } else {
                        // Group vdev (mirror, raidz, etc.)
                        const vdevNodeId = uid(`zfs-vdev-${vdev.type}`);
                        nodes.push(makeNode(vdevNodeId, 'zfs_vdev', `${vdev.type}`, {
                            shape: NodeShape.trapezoid,
                            badge: vdev.type,
                        }));
                        if (parentId)
                            edges.push(makeEdge(vdevNodeId, parentId));
                        if (vdev.children)
                            processVdevs(vdev.children, vdevNodeId);
                    }
                }
            };
            processVdevs(vdevs, poolNodeId);
        }
    }

    /* ── 7. Filesystems ──────────────────────────────────────────── */

    for (const path in client.blocks_fsys) {
        const fsys = client.blocks_fsys[path];
        const block = client.blocks[path];
        if (!block)
            continue;

        const mountPoints = fsys.MountPoints.map(decode_filename).filter(Boolean);
        if (mountPoints.length === 0)
            continue;

        const parentNodeId = blockNodeMap.get(path);
        if (!parentNodeId)
            continue;

        const mountLabel = mountPoints[0];
        const nodeId = `fs-${path}`;

        nodes.push(makeNode(nodeId, 'filesystem', mountLabel, {
            shape: NodeShape.ellipse,
            status: NodeStatus.success,
            badge: block.IdType || _("fs"),
            path,
        }));

        edges.push(makeEdge(parentNodeId, nodeId, { edgeStyle: EdgeStyle.dashed }));
    }

    /* ── 8. Swap ─────────────────────────────────────────────────── */

    for (const path in client.blocks_swap) {
        const block = client.blocks[path];
        if (!block)
            continue;

        const parentNodeId = blockNodeMap.get(path);
        if (!parentNodeId)
            continue;

        const nodeId = `swap-${path}`;
        nodes.push(makeNode(nodeId, 'swap', _("Swap"), {
            shape: NodeShape.ellipse,
            badge: fmt_size(block.Size),
            path,
            size: block.Size,
        }));

        edges.push(makeEdge(parentNodeId, nodeId, { edgeStyle: EdgeStyle.dashed }));
    }

    /* ── 9. Encrypted (LUKS) ─────────────────────────────────────── */

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
            shape: NodeShape.rect,
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

    return {
        graph: {
            id: 'storage-topology',
            type: 'graph',
            layout: 'Dagre',
        },
        nodes,
        edges,
    };
}

/* ── async data fetcher ──────────────────────────────────────────── */

/**
 * Fetch async topology data that is not available from D-Bus proxies.
 * Currently: ZFS vdev topology for each pool.
 *
 * Uses Promise.allSettled for graceful partial failure.
 *
 * @param {object} client – the storaged client singleton
 * @returns {Promise<{ zfsVdevs: Array }>}
 */
export async function fetchAsyncTopologyData(client) {
    const pools = Object.values(client.zfs_pools || {});
    if (pools.length === 0)
        return { zfsVdevs: [] };

    const results = await Promise.allSettled(
        pools.map(pool =>
            client.zfs_pool_call(pool.path, "GetVdevTopology", [{}])
                    .then(r => ({ poolPath: pool.path, poolName: pool.Name, vdevs: r[0] }))
        )
    );

    return {
        zfsVdevs: results
                .filter(r => r.status === 'fulfilled')
                .map(r => r.value),
    };
}
