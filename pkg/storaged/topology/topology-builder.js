/*
 * Copyright (C) 2026 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * topology-builder.js — Pure function that transforms the storaged client
 * data model into a { nodes, edges } graph structure compatible with
 * @patternfly/react-topology's Model interface.
 *
 * Design decisions:
 *   - Plugin registry (nodeProviders Map) so new device types can be added
 *     without touching the core builder.
 *   - GroupBy support (disabled by default) for future use.
 *   - Async ZFS vdev data via Promise.allSettled for partial graph rendering.
 *   - All node IDs use a type prefix to avoid collisions across namespaces.
 */

import cockpit from "cockpit";
import {
    block_short_name, drive_name, mdraid_name,
    fmt_size, decode_filename,
} from "../utils.js";

const _ = cockpit.gettext;

/* ---------------------------------------------------------------------------
 * Node type constants
 * -------------------------------------------------------------------------*/

export const NODE_TYPE_DRIVE = "drive";
export const NODE_TYPE_BLOCK = "block";
export const NODE_TYPE_PARTITION = "partition";
export const NODE_TYPE_LVM_VG = "lvm-vg";
export const NODE_TYPE_LVM_LV = "lvm-lv";
export const NODE_TYPE_LVM_PV = "lvm-pv";
export const NODE_TYPE_MDRAID = "mdraid";
export const NODE_TYPE_ZFS_POOL = "zfs-pool";
export const NODE_TYPE_ZFS_MEMBER = "zfs-member";
export const NODE_TYPE_FILESYSTEM = "filesystem";
export const NODE_TYPE_SWAP = "swap";
export const NODE_TYPE_ENCRYPTED = "encrypted";
export const NODE_TYPE_STRATIS_POOL = "stratis-pool";
export const NODE_TYPE_STRATIS_FSYS = "stratis-fsys";
export const NODE_TYPE_BTRFS_VOLUME = "btrfs-volume";
export const NODE_TYPE_NFS = "nfs";
export const NODE_TYPE_ISCSI = "iscsi";
export const NODE_TYPE_OTHER = "other";

/* ---------------------------------------------------------------------------
 * Health status mapping (used for NodeStatus in the graph)
 * -------------------------------------------------------------------------*/

export const STATUS_OK = "success";
export const STATUS_WARNING = "warning";
export const STATUS_DANGER = "danger";
export const STATUS_DEFAULT = "default";

/* ---------------------------------------------------------------------------
 * Plugin registry
 *
 * Each provider is a function (client, asyncData) => { nodes: [], edges: [] }
 * Providers are called in insertion order and their results are merged.
 * -------------------------------------------------------------------------*/

const nodeProviders = new Map();

export function registerNodeProvider(name, provider) {
    nodeProviders.set(name, provider);
}

export function unregisterNodeProvider(name) {
    nodeProviders.delete(name);
}

/* ---------------------------------------------------------------------------
 * Helper: create a node descriptor
 * -------------------------------------------------------------------------*/

function makeNode(id, type, label, data) {
    return {
        id,
        type,
        label,
        width: 120,
        height: 65,
        data: {
            status: STATUS_DEFAULT,
            badge: null,
            secondaryLabel: null,
            ...data,
        },
    };
}

/* ---------------------------------------------------------------------------
 * Helper: create an edge descriptor
 * -------------------------------------------------------------------------*/

function makeEdge(sourceId, targetId, type) {
    return {
        id: `edge-${sourceId}-to-${targetId}`,
        source: sourceId,
        target: targetId,
        type: type || "edge",
    };
}

/* ---------------------------------------------------------------------------
 * Built-in providers
 * -------------------------------------------------------------------------*/

function provideDrives(client) {
    const nodes = [];
    const edges = [];

    for (const path in client.drives) {
        const drive = client.drives[path];
        const block = client.drives_block[path];
        if (!block) continue;

        const cls = (drive.RotationRate === 0) ? "ssd" : "hdd";
        const name = drive_name(drive) || block_short_name(block);
        const size = block.Size;

        const nodeId = `drive:${path}`;
        nodes.push(makeNode(nodeId, NODE_TYPE_DRIVE, name, {
            path,
            badge: size ? fmt_size(size) : null,
            secondaryLabel: cls === "ssd" ? _("SSD") : _("HDD"),
            driveClass: cls,
            status: STATUS_OK,
        }));

        // Drive -> its block device
        const blockNodeId = `block:${block.path}`;
        edges.push(makeEdge(nodeId, blockNodeId));
    }

    return { nodes, edges };
}

function provideBlocks(client) {
    const nodes = [];
    const edges = [];

    for (const path in client.blocks) {
        const block = client.blocks[path];
        const nodeId = `block:${path}`;

        const shortName = block_short_name(block);
        const size = block.Size;

        const status = STATUS_OK;
        let secondaryLabel = null;

        // Determine what this block device is used as
        if (client.blocks_ptable[path]) {
            secondaryLabel = _("Partition table");
        } else if (client.blocks_part[path]) {
            secondaryLabel = _("Partition");
        } else if (client.blocks_fsys[path]) {
            const mounts = client.blocks_fsys[path].MountPoints;
            if (mounts && mounts.length > 0) {
                secondaryLabel = decode_filename(mounts[0]);
            } else {
                secondaryLabel = _("Filesystem");
            }
        } else if (client.blocks_swap[path]) {
            secondaryLabel = _("Swap");
        } else if (client.blocks_crypto[path]) {
            secondaryLabel = _("Encrypted");
        } else if (client.blocks_lvm2[path]) {
            secondaryLabel = _("LVM2");
        } else if (client.blocks_pvol[path]) {
            secondaryLabel = _("Physical volume");
        }

        nodes.push(makeNode(nodeId, NODE_TYPE_BLOCK, shortName, {
            path,
            badge: size ? fmt_size(size) : null,
            secondaryLabel,
            status,
        }));

        // Partition -> partition table edge
        if (client.blocks_part[path]) {
            const table = client.blocks_part[path].Table;
            if (table && table !== "/") {
                edges.push(makeEdge(`block:${table}`, nodeId));
            }
        }

        // CryptoBackingDevice edge: cleartext -> encrypted backing
        if (block.CryptoBackingDevice && block.CryptoBackingDevice !== "/") {
            edges.push(makeEdge(`block:${block.CryptoBackingDevice}`, nodeId));
        }
    }

    return { nodes, edges };
}

function providePartitions(client) {
    // Partitions are handled as block devices in provideBlocks.
    // This provider adds specific partition-type metadata.
    const nodes = [];
    const edges = [];

    for (const path in client.blocks_part) {
        const part = client.blocks_part[path];
        const nodeId = `block:${path}`;

        // Add type info as data update (the node itself is created in provideBlocks)
        // We use a convention where later providers can augment existing nodes
        nodes.push({
            id: nodeId,
            _augment: true,
            data: {
                nodeType: NODE_TYPE_PARTITION,
                partitionNumber: part.Number,
                partitionType: part.Type,
            },
        });
    }

    return { nodes, edges };
}

function provideLVM(client) {
    const nodes = [];
    const edges = [];

    // Volume groups
    for (const path in client.vgroups) {
        const vg = client.vgroups[path];
        const nodeId = `lvm-vg:${path}`;

        nodes.push(makeNode(nodeId, NODE_TYPE_LVM_VG, vg.Name, {
            path,
            badge: fmt_size(vg.Size),
            secondaryLabel: _("LVM2 volume group"),
            status: STATUS_OK,
        }));
    }

    // Physical volumes -> VG edges
    for (const path in client.blocks_pvol) {
        const pvol = client.blocks_pvol[path];
        if (pvol.VolumeGroup && pvol.VolumeGroup !== "/") {
            const blockNodeId = `block:${path}`;
            const vgNodeId = `lvm-vg:${pvol.VolumeGroup}`;
            edges.push(makeEdge(blockNodeId, vgNodeId));
        }
    }

    // Logical volumes
    for (const path in client.lvols) {
        const lvol = client.lvols[path];
        if (lvol.VolumeGroup && lvol.VolumeGroup !== "/") {
            const nodeId = `lvm-lv:${path}`;
            const block = client.lvols_block[path];

            const label = lvol.Name;
            let secondaryLabel = _("Logical volume");

            if (lvol.Type === "pool") {
                secondaryLabel = _("Thin pool");
            } else if (lvol.ThinPool && lvol.ThinPool !== "/") {
                secondaryLabel = _("Thin volume");
            } else if (lvol.Origin && lvol.Origin !== "/") {
                secondaryLabel = _("Snapshot");
            }

            nodes.push(makeNode(nodeId, NODE_TYPE_LVM_LV, label, {
                path,
                badge: fmt_size(lvol.Size),
                secondaryLabel,
                status: STATUS_OK,
            }));

            // VG -> LV edge
            edges.push(makeEdge(`lvm-vg:${lvol.VolumeGroup}`, nodeId));

            // LV -> block device edge (if exists)
            if (block) {
                edges.push(makeEdge(nodeId, `block:${block.path}`));
            }

            // Thin pool -> thin LV edge
            if (lvol.ThinPool && lvol.ThinPool !== "/") {
                edges.push(makeEdge(`lvm-lv:${lvol.ThinPool}`, nodeId));
            }
        }
    }

    return { nodes, edges };
}

function provideMDRAID(client) {
    const nodes = [];
    const edges = [];

    for (const path in client.mdraids) {
        const mdraid = client.mdraids[path];
        const block = client.mdraids_block[path];
        const nodeId = `mdraid:${path}`;

        let status = STATUS_OK;
        if (mdraid.Degraded > 0) {
            status = STATUS_WARNING;
        }
        if (!mdraid.Running) {
            status = STATUS_DEFAULT;
        }

        nodes.push(makeNode(nodeId, NODE_TYPE_MDRAID, mdraid_name(mdraid), {
            path,
            badge: mdraid.Level,
            secondaryLabel: _("MDRAID"),
            status,
        }));

        // Member blocks -> MDRAID edges
        const members = client.mdraids_members[path] || [];
        for (const member of members) {
            edges.push(makeEdge(`block:${member.path}`, nodeId));
        }

        // MDRAID -> its block device (if running)
        if (block) {
            edges.push(makeEdge(nodeId, `block:${block.path}`));
        }
    }

    return { nodes, edges };
}

function provideZFS(client, asyncData) {
    const nodes = [];
    const edges = [];

    for (const path in client.zfs_pools) {
        const pool = client.zfs_pools[path];
        const nodeId = `zfs-pool:${path}`;

        let status = STATUS_OK;
        const health = pool.Health;
        if (health === "DEGRADED") {
            status = STATUS_WARNING;
        } else if (health === "FAULTED" || health === "UNAVAIL") {
            status = STATUS_DANGER;
        }

        nodes.push(makeNode(nodeId, NODE_TYPE_ZFS_POOL, pool.Name, {
            path,
            badge: fmt_size(Number(pool.Size)),
            secondaryLabel: _("ZFS pool"),
            status,
            health,
        }));

        // If we have async vdev topology data, create sub-nodes
        if (asyncData && asyncData.zfsVdevs) {
            const vdevData = asyncData.zfsVdevs[path];
            if (vdevData && vdevData.status === "fulfilled" && vdevData.value) {
                for (const [idx, vdev] of vdevData.value.entries()) {
                    addZfsVdevNodes(nodes, edges, nodeId, vdev, `${path}-vdev-${idx}`);
                }
            }
        }
    }

    // ZFS block members -> pool edges
    for (const path in client.blocks_zfs) {
        const zfsBlock = client.blocks_zfs[path];
        if (zfsBlock.Pool && zfsBlock.Pool !== "/") {
            edges.push(makeEdge(`block:${path}`, `zfs-pool:${zfsBlock.Pool}`));
        }
    }

    return { nodes, edges };
}

function addZfsVdevNodes(nodes, edges, poolNodeId, vdev, keyPrefix) {
    const vdevId = `zfs-member:${keyPrefix}`;
    const label = vdev.path || vdev.type || _("unknown");

    nodes.push(makeNode(vdevId, NODE_TYPE_ZFS_MEMBER, label, {
        secondaryLabel: vdev.type || null,
        status: vdev.state === "ONLINE"
            ? STATUS_OK
            : (vdev.state === "DEGRADED" ? STATUS_WARNING : STATUS_DANGER),
    }));
    edges.push(makeEdge(poolNodeId, vdevId));

    if (vdev.children) {
        for (const [idx, child] of vdev.children.entries()) {
            addZfsVdevNodes(nodes, edges, vdevId, child, `${keyPrefix}-${idx}`);
        }
    }
}

function provideFilesystems(client) {
    const nodes = [];
    const edges = [];

    for (const path in client.blocks_fsys) {
        const fsys = client.blocks_fsys[path];
        const block = client.blocks[path];
        if (!block) continue;

        const mounts = fsys.MountPoints || [];
        if (mounts.length > 0) {
            const mountPoint = decode_filename(mounts[0]);
            const nodeId = `filesystem:${path}`;

            nodes.push(makeNode(nodeId, NODE_TYPE_FILESYSTEM, mountPoint, {
                path,
                secondaryLabel: _("Filesystem"),
                status: STATUS_OK,
            }));

            edges.push(makeEdge(`block:${path}`, nodeId));
        }
    }

    return { nodes, edges };
}

function provideSwap(client) {
    const nodes = [];
    const edges = [];

    for (const path in client.blocks_swap) {
        const swap = client.blocks_swap[path];
        const block = client.blocks[path];
        if (!block) continue;

        const active = swap.Active;
        const nodeId = `swap:${path}`;

        nodes.push(makeNode(nodeId, NODE_TYPE_SWAP, block_short_name(block), {
            path,
            secondaryLabel: _("Swap"),
            status: active ? STATUS_OK : STATUS_DEFAULT,
        }));

        edges.push(makeEdge(`block:${path}`, nodeId));
    }

    return { nodes, edges };
}

function provideEncrypted(client) {
    // Encrypted devices are shown as block devices with edges.
    // The cleartext -> backing edge is already created in provideBlocks.
    // This provider adds type augmentation.
    const nodes = [];

    for (const path in client.blocks_crypto) {
        nodes.push({
            id: `block:${path}`,
            _augment: true,
            data: {
                nodeType: NODE_TYPE_ENCRYPTED,
                encrypted: true,
            },
        });
    }

    return { nodes, edges: [] };
}

function provideStratis(client) {
    const nodes = [];
    const edges = [];

    for (const path in client.stratis_pools) {
        const pool = client.stratis_pools[path];
        const nodeId = `stratis-pool:${path}`;

        nodes.push(makeNode(nodeId, NODE_TYPE_STRATIS_POOL, pool.Name, {
            path,
            secondaryLabel: _("Stratis pool"),
            status: STATUS_OK,
        }));

        // Block devices belonging to this pool
        const blockdevs = client.stratis_pool_blockdevs[path] || [];
        for (const bd of blockdevs) {
            const physBlock = client.slashdevs_block[bd.PhysicalPath];
            if (physBlock) {
                edges.push(makeEdge(`block:${physBlock.path}`, nodeId));
            }
        }

        // Stratis filesystems
        const filesystems = client.stratis_pool_filesystems[path] || [];
        for (const fs of filesystems) {
            const fsNodeId = `stratis-fsys:${fs.path}`;
            nodes.push(makeNode(fsNodeId, NODE_TYPE_STRATIS_FSYS, fs.Name, {
                path: fs.path,
                secondaryLabel: _("Stratis filesystem"),
                status: STATUS_OK,
            }));
            edges.push(makeEdge(nodeId, fsNodeId));
        }
    }

    return { nodes, edges };
}

function provideBtrfs(client) {
    const nodes = [];
    const edges = [];

    for (const uuid in client.uuids_btrfs_volume) {
        const btrfs = client.uuids_btrfs_volume[uuid];
        const nodeId = `btrfs-volume:${uuid}`;

        nodes.push(makeNode(nodeId, NODE_TYPE_BTRFS_VOLUME, btrfs.data?.label || uuid, {
            uuid,
            secondaryLabel: _("Btrfs volume"),
            status: STATUS_OK,
        }));

        // Member blocks
        const blocks = client.uuids_btrfs_blocks[uuid] || [];
        for (const block of blocks) {
            edges.push(makeEdge(`block:${block.path}`, nodeId));
        }
    }

    return { nodes, edges };
}

function provideNFS(client) {
    const nodes = [];
    const edges = [];

    if (!client.nfs || !client.nfs.entries) return { nodes, edges };

    for (const [idx, entry] of client.nfs.entries.entries()) {
        const nodeId = `nfs:${idx}`;
        const label = `${entry.fields[0]}:${entry.fields[1]}`;

        nodes.push(makeNode(nodeId, NODE_TYPE_NFS, label, {
            secondaryLabel: _("NFS mount"),
            mountPoint: entry.fields[2] || null,
            status: STATUS_OK,
        }));
    }

    return { nodes, edges };
}

function provideISCSI(client) {
    const nodes = [];
    const edges = [];

    for (const path in client.iscsi_sessions) {
        const session = client.iscsi_sessions[path];
        const nodeId = `iscsi:${path}`;

        nodes.push(makeNode(nodeId, NODE_TYPE_ISCSI, session.data?.target_name || path, {
            path,
            secondaryLabel: _("iSCSI session"),
            status: STATUS_OK,
        }));

        // iSCSI session -> drives
        const drives = client.iscsi_sessions_drives[path] || [];
        for (const drive of drives) {
            edges.push(makeEdge(nodeId, `drive:${drive.path}`));
        }
    }

    return { nodes, edges };
}

/* ---------------------------------------------------------------------------
 * Register all built-in providers
 * -------------------------------------------------------------------------*/

registerNodeProvider("drives", provideDrives);
registerNodeProvider("blocks", provideBlocks);
registerNodeProvider("partitions", providePartitions);
registerNodeProvider("lvm", provideLVM);
registerNodeProvider("mdraid", provideMDRAID);
registerNodeProvider("zfs", provideZFS);
registerNodeProvider("filesystems", provideFilesystems);
registerNodeProvider("swap", provideSwap);
registerNodeProvider("encrypted", provideEncrypted);
registerNodeProvider("stratis", provideStratis);
registerNodeProvider("btrfs", provideBtrfs);
registerNodeProvider("nfs", provideNFS);
registerNodeProvider("iscsi", provideISCSI);

/* ---------------------------------------------------------------------------
 * Async ZFS vdev data fetcher
 *
 * Uses Promise.allSettled so partial graph rendering works even if some
 * pools fail to return vdev data.
 * -------------------------------------------------------------------------*/

export async function fetchZfsVdevData(client) {
    const pools = Object.keys(client.zfs_pools || {});
    if (pools.length === 0) return {};

    function parseVdev(v) {
        return {
            path: v.path?.v || "",
            type: v.type?.v || "",
            state: v.state?.v || "UNKNOWN",
            children: v.children?.v ? v.children.v.map(parseVdev) : null,
        };
    }

    const promises = pools.map(path =>
        client.zfs_pool_call(path, "GetVdevTopology", [{}])
            .then(result => result[0].map(parseVdev))
    );

    const results = await Promise.allSettled(promises);
    const vdevData = {};
    for (let i = 0; i < pools.length; i++) {
        vdevData[pools[i]] = results[i];
    }
    return vdevData;
}

/* ---------------------------------------------------------------------------
 * Main builder function
 *
 * buildTopologyGraph(client, asyncData) -> { nodes: [], edges: [] }
 *
 * asyncData is an optional object:
 *   { zfsVdevs: { [poolPath]: PromiseSettledResult } }
 *
 * The returned structure is ready to be fed to
 * @patternfly/react-topology's controller.fromModel({ graph, nodes, edges }).
 * -------------------------------------------------------------------------*/

export function buildTopologyGraph(client, asyncData) {
    const allNodes = new Map(); // id -> node
    const allEdges = [];
    const augments = []; // deferred augmentations

    for (const [, provider] of nodeProviders) {
        let result;
        try {
            result = provider(client, asyncData);
        } catch (e) {
            console.warn("Topology provider error:", e);
            continue;
        }

        for (const node of (result.nodes || [])) {
            if (node._augment) {
                augments.push(node);
            } else if (!allNodes.has(node.id)) {
                allNodes.set(node.id, node);
            }
        }

        for (const edge of (result.edges || [])) {
            allEdges.push(edge);
        }
    }

    // Apply augmentations: merge data from augment entries into existing nodes
    for (const aug of augments) {
        const existing = allNodes.get(aug.id);
        if (existing && aug.data) {
            existing.data = { ...existing.data, ...aug.data };
        }
    }

    // Filter edges: remove edges that reference non-existent nodes
    const validEdges = allEdges.filter(
        edge => allNodes.has(edge.source) && allNodes.has(edge.target)
    );

    // Deduplicate edges by id
    const edgeMap = new Map();
    for (const edge of validEdges) {
        if (!edgeMap.has(edge.id)) {
            edgeMap.set(edge.id, edge);
        }
    }

    return {
        nodes: Array.from(allNodes.values()),
        edges: Array.from(edgeMap.values()),
    };
}

/* ---------------------------------------------------------------------------
 * GroupBy support (disabled by default)
 *
 * When enabled, nodes are wrapped in group nodes by the specified field.
 * This is kept as a utility for future extension.
 * -------------------------------------------------------------------------*/

export function groupNodesBy(graphData, field) {
    const groups = new Map();
    const ungrouped = [];

    for (const node of graphData.nodes) {
        const groupKey = node.data?.[field];
        if (groupKey) {
            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    id: `group:${field}:${groupKey}`,
                    type: "group",
                    label: groupKey,
                    children: [],
                    group: true,
                    style: { padding: 20 },
                    data: { groupBy: field },
                });
            }
            groups.get(groupKey).children.push(node.id);
        } else {
            ungrouped.push(node);
        }
    }

    return {
        nodes: [...graphData.nodes, ...groups.values()],
        edges: graphData.edges,
    };
}
