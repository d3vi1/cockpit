/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Build a dagre-compatible graph model from UDisks2 client data.
 *
 * HIERARCHICAL LAYOUT  (rotated lsblk — all devices, no filtering):
 *   Level 0 (top):    ALL block devices (loop*, vd*, sd*, etc. — NOT zd* zvol blocks)
 *   Level 1 (middle): Storage pools (ZFS pools, LVM VGs, MDRAID)
 *   Level 2 (bottom): Logical volumes / datasets (LVM LVs, ZFS zvols)
 *
 * Every block device is shown.  Standalone disks (no pool membership)
 * appear at Level 0 without edges.
 */

const NodeStatus = { default: 'default', success: 'success', warning: 'warning', danger: 'danger' };
import {
    decode_filename, block_short_name,
    drive_name, mdraid_name, fmt_size,
} from "../utils.js";

/* -- helpers -------------------------------------------------------- */

function safe_fmt_size(bytes) {
    const result = fmt_size(bytes);
    if (result == null) return "";
    if (typeof result === "string") return result;
    if (Array.isArray(result)) return result.join(" ");
    return String(result);
}

function safeLabel(val) {
    if (val == null) return "";
    if (typeof val === "string") return val;
    if (typeof val === "number") return String(val);
    if (Array.isArray(val)) return val.join(" ");
    if (typeof val === "object" && val.v !== undefined) return String(val.v);
    return String(val);
}

/* -- node/edge factories ------------------------------------------- */

const NODE_WIDTH = 200;
const NODE_HEIGHT = 36;

function makeNode(id, nodeType, label, opts) {
    return {
        id,
        type: 'node',
        label: safeLabel(label) || id,
        width: opts?.width || NODE_WIDTH,
        height: opts?.height || NODE_HEIGHT,
        shape: 'rect',
        data: {
            nodeType,
            badge: safeLabel(opts?.badge),
            badgeColor: opts?.badgeColor,
            secondaryLabel: safeLabel(opts?.secondaryLabel),
            status: opts?.status || NodeStatus.default,
            path: opts?.path,
            navigateTo: opts?.navigateTo,
            poolNodeId: opts?.poolNodeId,
        },
        ...(opts?.status ? { status: opts.status } : {}),
    };
}

function makeEdge(source, target) {
    return {
        id: `edge-${source}-${target}`,
        type: 'edge',
        source,
        target,
    };
}

/* -- main builder -------------------------------------------------- */

export function buildTopologyModel(client, asyncData) {
    const nodes = [];
    const edges = [];
    const nodeIds = new Set();

    const blockToNodeId = new Map();
    /* poolNodeId -> Set of disk nodeIds (for post-layout compaction) */
    const poolMembers = new Map();

    /* ==============================================================
     * Level 0: ALL block devices
     * ============================================================== */

    /* Drive-backed blocks */
    for (const drivePath in client.drives) {
        const drive = client.drives[drivePath];
        const block = client.drives_block[drivePath];
        if (!block) continue;

        const dName = drive_name(drive) || "";
        const shortName = block_short_name(block);
        const name = dName ? `${shortName} - ${dName}` : shortName;
        const size = safe_fmt_size(drive.Size);
        const bus = safeLabel(drive.ConnectionBus || drive.Media || "");
        const nodeId = `disk-${block.path}`;
        const label = size ? `${name} (${size})` : name;

        nodes.push(makeNode(nodeId, 'disk', label, {
            badge: bus || "Disk",
            status: _driveStatus(drive, client),
            path: block.path,
            navigateTo: [block_short_name(block)],
        }));
        nodeIds.add(nodeId);
        blockToNodeId.set(block.path, nodeId);
    }

    /* Loop + driveless blocks (NOT claimed by a drive, NOT zd* zvol blocks) */
    for (const path in client.blocks) {
        const block = client.blocks[path];
        if (blockToNodeId.has(path)) continue;
        if (client.blocks_part[path]) continue;
        if (block.CryptoBackingDevice && block.CryptoBackingDevice !== "/") continue;
        if (block.MDRaid && block.MDRaid !== "/") continue;
        if (block.Drive && block.Drive !== "/") continue;
        /* Skip LVM LVs (but NOT PVs — PVs are pool members, we want them) */
        const lvm2 = client.blocks_lvm2[path];
        if (lvm2 && lvm2.LogicalVolume && lvm2.LogicalVolume !== "/") continue;
        if (block.Size === 0) continue;
        if (block.HintIgnore) continue;

        const devName = decode_filename(block.Device);
        /* Skip zd* zvol block devices — those are representations of zvol datasets */
        if (devName.startsWith("/dev/zd")) continue;

        const shortName = block_short_name(block);
        const size = safe_fmt_size(block.Size);
        const isLoop = devName.startsWith("/dev/loop");
        const nodeId = `disk-${path}`;
        const label = size ? `${shortName} (${size})` : shortName;

        nodes.push(makeNode(nodeId, 'disk', label, {
            badge: isLoop ? "Loop" : "Block",
            path,
            navigateTo: [shortName],
        }));
        nodeIds.add(nodeId);
        blockToNodeId.set(path, nodeId);
    }

    /* ==============================================================
     * Level 1: MDRAID
     * ============================================================== */

    for (const path in client.mdraids) {
        const mdraid = client.mdraids[path];
        const raidBlock = client.mdraids_block[path];
        const name = mdraid_name(mdraid) || (raidBlock ? block_short_name(raidBlock) : path);
        const level = mdraid.Level ? mdraid.Level.toUpperCase() : "";
        const size = safe_fmt_size(mdraid.Size);
        const label = size ? `${name} (${size})` : name;

        const nodeId = `mdraid-${path}`;
        nodes.push(makeNode(nodeId, 'mdraid', label, {
            badge: level || "RAID",
            status: _mdraidStatus(mdraid),
            path,
            navigateTo: ["mdraid", mdraid.UUID],
        }));
        nodeIds.add(nodeId);

        const memberSet = new Set();
        const members = client.mdraids_members[path] || [];
        for (const member of members) {
            const diskNodeId = blockToNodeId.get(member.path);
            if (diskNodeId) {
                edges.push(makeEdge(diskNodeId, nodeId));
                memberSet.add(diskNodeId);
            }
        }
        poolMembers.set(nodeId, memberSet);
    }

    /* ==============================================================
     * Level 1: LVM VGs
     * ============================================================== */

    const vgNodeMap = new Map();

    for (const path in client.vgroups) {
        const vg = client.vgroups[path];
        const size = safe_fmt_size(vg.Size);
        const label = size ? `${vg.Name} (${size})` : vg.Name;

        const nodeId = `vg-${path}`;
        nodes.push(makeNode(nodeId, 'lvm_vg', label, {
            badge: "VG",
            status: NodeStatus.success,
            path,
            navigateTo: ["vg", vg.Name],
        }));
        nodeIds.add(nodeId);
        vgNodeMap.set(path, nodeId);

        /* Edges: PV disks -> VG */
        const memberSet = new Set();
        const pvols = client.vgroups_pvols[path] || [];
        for (const pv of pvols) {
            const diskNodeId = blockToNodeId.get(pv.path);
            if (diskNodeId) {
                edges.push(makeEdge(diskNodeId, nodeId));
                memberSet.add(diskNodeId);
            }
        }
        poolMembers.set(nodeId, memberSet);
    }

    /* ==============================================================
     * Level 1: ZFS Pools
     * ============================================================== */

    const zfsPoolNodeMap = new Map();

    for (const path in client.zfs_pools) {
        const pool = client.zfs_pools[path];
        const size = safe_fmt_size(Number(pool.Size));
        const label = size ? `${pool.Name} (${size})` : pool.Name;

        let secondary = "";
        const vdevData = asyncData?.zfsVdevs?.find(v => v.poolPath === path);
        if (vdevData && Array.isArray(vdevData.vdevs) && vdevData.vdevs.length > 0) {
            const vdevParts = [];
            for (const vdev of vdevData.vdevs) {
                const vtype = safeLabel(vdev.type?.v || vdev.type || "");
                if (vtype !== "disk" && vtype !== "file")
                    vdevParts.push(vtype);
            }
            if (vdevParts.length > 0) secondary = vdevParts.join(" + ");
        }
        const dsData = asyncData?.zfsDatasets?.find(d => d.poolPath === path);
        if (dsData && Array.isArray(dsData.datasets)) {
            const dsCount = dsData.datasets.filter(ds => (ds.name || "") !== pool.Name).length;
            if (dsCount > 0)
                secondary += (secondary ? " \u00b7 " : "") + dsCount + " dataset" + (dsCount !== 1 ? "s" : "");
        }

        const nodeId = `zfs-pool-${path}`;
        nodes.push(makeNode(nodeId, 'zfs_pool', label, {
            badge: pool.State || "Pool",
            secondaryLabel: secondary,
            status: _zfsPoolStatus(pool),
            path,
            navigateTo: ["zpool", pool.Name],
        }));
        nodeIds.add(nodeId);
        zfsPoolNodeMap.set(path, nodeId);

        const memberSet = new Set();

        /* Match via vdev topology leaf paths (GetVdevTopology is the only
         * reliable membership source — Block.ZFS.Pool is based on ID_FS_LABEL
         * which persists on disk even after a device is removed from the pool) */
        if (vdevData && Array.isArray(vdevData.vdevs)) {
            const leafPaths = _collectVdevLeafBlockPaths(vdevData.vdevs, client);
            for (const bpath of leafPaths) {
                const diskNodeId = blockToNodeId.get(bpath);
                if (diskNodeId) {
                    edges.push(makeEdge(diskNodeId, nodeId));
                    memberSet.add(diskNodeId);
                }
            }
        }

        poolMembers.set(nodeId, memberSet);
    }

    /* ==============================================================
     * Level 2: LVM LVs
     * ============================================================== */

    for (const path in client.lvols) {
        const lvol = client.lvols[path];
        if (!lvol.VolumeGroup || lvol.VolumeGroup === "/") continue;
        if (lvol.Type === "pool") continue;
        const name = lvol.Name;
        const size = safe_fmt_size(lvol.Size);
        const label = size ? `${name} (${size})` : name;
        let badge = "LV";
        if (lvol.ThinPool && lvol.ThinPool !== "/") badge = "Thin LV";
        const nodeId = `lv-${path}`;
        nodes.push(makeNode(nodeId, 'lvm_lv', label, { badge, path }));
        nodeIds.add(nodeId);
        const vgNodeId = vgNodeMap.get(lvol.VolumeGroup);
        if (vgNodeId) edges.push(makeEdge(vgNodeId, nodeId));
    }

    /* ==============================================================
     * Level 2: ZFS Zvols
     * ============================================================== */

    if (asyncData?.zfsDatasets) {
        for (const { poolPath, datasets } of asyncData.zfsDatasets) {
            const poolNodeId = zfsPoolNodeMap.get(poolPath);
            if (!poolNodeId || !Array.isArray(datasets)) continue;
            for (const ds of datasets) {
                const dsName = ds.name || "";
                const dsType = ds.type || "filesystem";
                if (dsType !== "volume") continue;
                const poolObj = client.zfs_pools[poolPath];
                if (poolObj && dsName === poolObj.Name) continue;
                const size = safe_fmt_size(ds.used || 0);
                const shortName = dsName.includes("/") ? dsName.split("/").slice(1).join("/") : dsName;
                const label = size ? `${shortName} (${size})` : shortName;
                const dsNodeId = `zvol-${poolPath}-${dsName}`;
                nodes.push(makeNode(dsNodeId, 'zfs_zvol', label, {
                    badge: "Zvol", path: poolPath,
                    navigateTo: ["zpool", poolObj?.Name],
                }));
                nodeIds.add(dsNodeId);
                edges.push(makeEdge(poolNodeId, dsNodeId));
            }
        }
    }

    /* ==============================================================
     * Deduplicate edges
     * ============================================================== */

    const edgeSet = new Set();
    const uniqueEdges = [];
    for (const e of edges) {
        if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
        const key = `${e.source}|${e.target}`;
        if (!edgeSet.has(key)) {
            edgeSet.add(key);
            uniqueEdges.push(e);
        }
    }

    /* No filtering — all nodes are included regardless of edge membership */

    return {
        graph: { id: 'storage-topology', type: 'graph', layout: 'Dagre' },
        nodes,
        edges: uniqueEdges,
        _poolMembers: poolMembers,
    };
}

/* -- helpers -------------------------------------------------------- */

function _collectVdevLeafBlockPaths(vdevs, client) {
    const paths = new Set();
    function walk(vdevList) {
        if (!Array.isArray(vdevList)) return;
        for (const vdev of vdevList) {
            const vtype = safeLabel(vdev.type?.v || vdev.type || "");
            if (vtype === "disk" || vtype === "file") {
                const devPath = vdev.path?.v || vdev.path || "";
                if (devPath) {
                    const slashBlock = client.slashdevs_block?.[devPath];
                    if (slashBlock) paths.add(slashBlock.path);
                }
            } else {
                // Skip non-data vdev groups (spares, cache, log)
                if (vtype === "spare" || vtype === "cache" || vtype === "log" ||
                    vtype === "special" || vtype === "dedup")
                    continue;
                const children = vdev.children?.v || vdev.children || [];
                if (Array.isArray(children)) walk(children);
            }
        }
    }
    walk(vdevs);
    return paths;
}

function _driveStatus(drive, client) {
    if (!drive) return NodeStatus.default;
    const ata = drive.path && client.drives_ata?.[drive.path];
    if (ata && ata.SmartFailing) return NodeStatus.danger;
    return NodeStatus.default;
}

function _mdraidStatus(mdraid) {
    if (!mdraid) return NodeStatus.default;
    if (mdraid.Degraded > 0) return NodeStatus.warning;
    return NodeStatus.success;
}

function _zfsPoolStatus(pool) {
    if (!pool) return NodeStatus.default;
    const state = pool.State;
    if (state === "ONLINE") return NodeStatus.success;
    if (state === "DEGRADED") return NodeStatus.warning;
    if (state === "FAULTED" || state === "UNAVAIL") return NodeStatus.danger;
    return NodeStatus.default;
}

/* -- async data fetcher --------------------------------------------- */

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
        zfsVdevs: vdevResults.filter(r => r.status === 'fulfilled').map(r => r.value),
        zfsDatasets: datasetResults.filter(r => r.status === 'fulfilled').map(r => r.value),
    };
}
