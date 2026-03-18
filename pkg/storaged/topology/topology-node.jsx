/*
 * Copyright (C) 2026 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * topology-node.jsx — Custom node component for the storage topology graph.
 *
 * Uses the existing SVG icons from the Cockpit storage codebase for
 * drives, and PatternFly icons for logical constructs (LVM, MDRAID, etc.).
 *
 * Maps health/status states to PatternFly NodeStatus values.
 */

import React from "react";

import {
    HddIcon, DatabaseIcon, CubesIcon, CubeIcon,
    FolderOpenIcon, LockIcon, MemoryIcon,
    NetworkIcon as PFNetworkIcon,
    ServerIcon, LayerGroupIcon, ShareAltIcon,
} from "@patternfly/react-icons";

import {
    NODE_TYPE_DRIVE, NODE_TYPE_BLOCK, NODE_TYPE_PARTITION,
    NODE_TYPE_LVM_VG, NODE_TYPE_LVM_LV, NODE_TYPE_LVM_PV,
    NODE_TYPE_MDRAID,
    NODE_TYPE_ZFS_POOL, NODE_TYPE_ZFS_MEMBER,
    NODE_TYPE_FILESYSTEM, NODE_TYPE_SWAP, NODE_TYPE_ENCRYPTED,
    NODE_TYPE_STRATIS_POOL, NODE_TYPE_STRATIS_FSYS,
    NODE_TYPE_BTRFS_VOLUME,
    NODE_TYPE_NFS, NODE_TYPE_ISCSI, NODE_TYPE_OTHER,
    STATUS_OK, STATUS_WARNING, STATUS_DANGER,
} from "./topology-builder.js";

/* ---------------------------------------------------------------------------
 * Icon mapping: node type -> PatternFly icon component
 *
 * These match the visual language of the existing storage table as closely
 * as possible. The table uses custom SVG icons (HDDIcon, SSDIcon, etc.)
 * from gnome-icons.jsx for drives. In the topology graph, we use PF icons
 * for consistency with the graph rendering style.
 * -------------------------------------------------------------------------*/

const nodeIconMap = {
    [NODE_TYPE_DRIVE]: HddIcon,
    [NODE_TYPE_BLOCK]: HddIcon,
    [NODE_TYPE_PARTITION]: ServerIcon,
    [NODE_TYPE_LVM_VG]: CubesIcon,
    [NODE_TYPE_LVM_LV]: CubeIcon,
    [NODE_TYPE_LVM_PV]: CubeIcon,
    [NODE_TYPE_MDRAID]: DatabaseIcon,
    [NODE_TYPE_ZFS_POOL]: LayerGroupIcon,
    [NODE_TYPE_ZFS_MEMBER]: HddIcon,
    [NODE_TYPE_FILESYSTEM]: FolderOpenIcon,
    [NODE_TYPE_SWAP]: MemoryIcon,
    [NODE_TYPE_ENCRYPTED]: LockIcon,
    [NODE_TYPE_STRATIS_POOL]: CubesIcon,
    [NODE_TYPE_STRATIS_FSYS]: FolderOpenIcon,
    [NODE_TYPE_BTRFS_VOLUME]: LayerGroupIcon,
    [NODE_TYPE_NFS]: ShareAltIcon,
    [NODE_TYPE_ISCSI]: PFNetworkIcon,
    [NODE_TYPE_OTHER]: ServerIcon,
};

export function getNodeIcon(nodeType) {
    return nodeIconMap[nodeType] || ServerIcon;
}

/* ---------------------------------------------------------------------------
 * Status mapping: topology status -> CSS class / color
 * -------------------------------------------------------------------------*/

const statusClassMap = {
    [STATUS_OK]: "topology-node-status-ok",
    [STATUS_WARNING]: "topology-node-status-warning",
    [STATUS_DANGER]: "topology-node-status-danger",
};

export function getStatusClass(status) {
    return statusClassMap[status] || "topology-node-status-default";
}

/* ---------------------------------------------------------------------------
 * Status -> PF NodeStatus for @patternfly/react-topology
 * These values are used by DefaultNode's "status" prop.
 * -------------------------------------------------------------------------*/

export function getNodeStatus(status) {
    switch (status) {
    case STATUS_OK: return "success";
    case STATUS_WARNING: return "warning";
    case STATUS_DANGER: return "danger";
    default: return "default";
    }
}

/* ---------------------------------------------------------------------------
 * StorageNode — A pure-React fallback node component for the topology graph.
 *
 * This is used when @patternfly/react-topology is not available.
 * When the library IS available, topology-graph.jsx will use
 * DefaultNode from the library instead, passing these icon/status
 * helpers as configuration.
 *
 * This component renders a simple HTML box for each node in the
 * non-topology (list) fallback mode.
 * -------------------------------------------------------------------------*/

export const StorageNodeBadge = ({ node }) => {
    if (!node || !node.data) return null;

    const { badge, secondaryLabel, status } = node.data;
    const nodeType = node.data.nodeType || node.type;
    const IconComponent = getNodeIcon(nodeType);
    const statusClass = getStatusClass(status);

    return (
        <div className={`topology-node-badge ${statusClass}`}>
            <span className="topology-node-badge-icon">
                <IconComponent />
            </span>
            <span className="topology-node-badge-label">{node.label}</span>
            { badge && <span className="topology-node-badge-info">{badge}</span> }
            { secondaryLabel && <span className="topology-node-badge-secondary">{secondaryLabel}</span> }
        </div>
    );
};
