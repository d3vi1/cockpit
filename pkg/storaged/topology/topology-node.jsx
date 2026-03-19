/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Icon components and helpers for storage topology node rendering.
 * Pure SVG/React -- no @patternfly/react-topology imports.
 *
 * Paths from GNOME project icons (LGPL-3.0+ / CC-BY-SA-3.0).
 */

import React from "react";

export const DiskIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14">
        <path d="m 4 0 c -1.644531 0 -3 1.355469 -3 3 v 10 c 0 1.644531 1.355469 3 3 3 h 8 c 1.644531 0 3 -1.355469 3 -3 v -10 c 0 -1.644531 -1.355469 -3 -3 -3 z m 0 2 h 8 c 0.570312 0 1 0.429688 1 1 v 9 c 0 0.570312 -0.429688 1 -1 1 h -8 c -0.554688 0 -1 -0.445312 -1 -1 v -9 c 0 -0.554688 0.445312 -1 1 -1 z m 4 1 c -2.210938 0 -4 1.789062 -4 4 v 4 h 4 c 2.5 0 4 -1.789062 4 -4 s -1.789062 -4 -4 -4 z m 0 2 c 1.105469 0 2 0.894531 2 2 s -0.894531 2 -2 2 s -2 -0.894531 -2 -2 s 0.894531 -2 2 -2 z m 0 0" fill="currentColor" />
    </svg>
);

export const PoolIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14">
        <path d="m 4 0 c -1.644531 0 -3 1.355469 -3 3 v 6 c 0 1.644531 1.355469 3 3 3 h 5 c 1.644531 0 3 -1.355469 3 -3 v -6 c 0 -1.644531 -1.355469 -3 -3 -3 z m 0 2 h 5 c 0.570312 0 0.886719 0.441406 1 1 v 5 c 0 0.472656 -0.429688 1 -1 1 h -5 c -0.554688 0 -1 -0.445312 -1 -1 v -5 c 0 -0.554688 0.445312 -1 1 -1 z m 2.503906 1.003906 c -1.375 0 -2.515625 1.128906 -2.5 2.5 l -0.003906 2.496094 h 2.5 c 1.371094 0 2.5 -1.125 2.5 -2.496094 c 0 -1.375 -1.128906 -2.5 -2.5 -2.5 z m 6.496094 1.175782 v 7.820312 c 0 0.472656 -0.429688 1 -1 1 h -8 c 0 1.644531 1.355469 3 3 3 h 5 c 1.644531 0 3 -1.355469 3 -3 v -6 c 0 -1.292969 -0.839844 -2.40625 -2 -2.820312 z m -6.492188 0.320312 c 0.550782 0 1 0.449219 1 1 s -0.449218 1 -1 1 c -0.554687 0 -1 -0.449219 -1 -1 s 0.445313 -1 1 -1 z m 0 0" fill="currentColor" />
    </svg>
);

export const VolumeIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14">
        <path d="M 4,0 C 2.355469,0 1,1.355469 1,3 v 10 c 0,1.644531 1.355469,3 3,3 h 8 c 1.644531,0 3,-1.355469 3,-3 V 3 C 15,1.355469 13.644531,0 12,0 Z m 0,2 h 8 c 0.570312,0 1,0.429688 1,1 v 9 c 0,0.570312 -0.429688,1 -1,1 H 4 C 3.445312,13 3,12.554688 3,12 V 3 C 3,2.445312 3.445312,2 4,2 Z" fill="currentColor" />
    </svg>
);

/**
 * Return the icon component for a given node type string.
 */
export function getIconForType(type) {
    switch (type) {
    case 'disk':
        return DiskIcon;
    case 'lvm_vg':
    case 'zfs_pool':
    case 'mdraid':
        return PoolIcon;
    case 'lvm_lv':
    case 'zfs_zvol':
        return VolumeIcon;
    default:
        return VolumeIcon;
    }
}

/**
 * Map a PF-style NodeStatus string to a CSS color for the node stroke.
 */
export function statusStrokeColor(status) {
    switch (status) {
    case 'success':
        return 'var(--pf-t--global--color--status--success--default, #3e8635)';
    case 'warning':
        return 'var(--pf-t--global--color--status--warning--default, #f0ab00)';
    case 'danger':
        return 'var(--pf-t--global--color--status--danger--default, #c9190b)';
    default:
        return 'var(--pf-t--global--border--color--default, #6a6e73)';
    }
}
