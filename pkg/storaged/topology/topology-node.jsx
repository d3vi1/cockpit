/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Custom component factory for storage-specific topology node rendering.
 * Provides a storageComponentFactory for @patternfly/react-topology.
 */

import React from "react";
import {
    DefaultEdge,
    DefaultGroup,
    DefaultNode,
    GraphComponent,
    ModelKind,
    withDragNode,
    withPanZoom,
    withSelection,
} from "@patternfly/react-topology";

import { HddIcon } from "@patternfly/react-icons/dist/esm/icons/hdd-icon";
import { DatabaseIcon } from "@patternfly/react-icons/dist/esm/icons/database-icon";
import { CubesIcon } from "@patternfly/react-icons/dist/esm/icons/cubes-icon";
import { FolderOpenIcon } from "@patternfly/react-icons/dist/esm/icons/folder-open-icon";
import { LockIcon } from "@patternfly/react-icons/dist/esm/icons/lock-icon";

/** Pick an icon class for a given storage node type */
function getIconForType(type) {
    switch (type) {
    case 'drive':
    case 'disk':
    case 'partition':
    case 'lvm_pv':
    case 'zfs_member':
        return HddIcon;
    case 'lvm_vg':
    case 'zfs_pool':
    case 'zfs_vdev':
    case 'mdraid':
        return CubesIcon;
    case 'lvm_lv':
    case 'zfs_dataset':
        return DatabaseIcon;
    case 'filesystem':
        return FolderOpenIcon;
    case 'encrypted':
        return LockIcon;
    case 'swap':
        return DatabaseIcon;
    default:
        return DatabaseIcon;
    }
}

/** Custom node component that renders storage-specific badges and icons */
const StorageNode = ({ element, ...rest }) => {
    const data = element.getData();
    const Icon = getIconForType(data?.nodeType);

    return (
        <DefaultNode
            element={element}
            showStatusDecorator
            badge={data?.badge}
            badgeColor={data?.badgeColor}
            {...rest}
        >
            {Icon && (
                <g transform="translate(12, 12)">
                    <Icon width={16} height={16} />
                </g>
            )}
        </DefaultNode>
    );
};

const StorageNodeWithExtras = withDragNode()(withSelection()(StorageNode));

/**
 * Component factory for @patternfly/react-topology.
 *
 * This tells the visualization controller which React component to
 * render for each kind of model element (graph, node, edge, group).
 */
export function storageComponentFactory(kind, type) {
    switch (kind) {
    case ModelKind.graph:
        return withPanZoom()(GraphComponent);
    case ModelKind.node:
        return StorageNodeWithExtras;
    case ModelKind.edge:
        return DefaultEdge;
    case ModelKind.group:
        return DefaultGroup;
    default:
        return undefined;
    }
}
