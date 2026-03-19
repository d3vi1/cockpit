/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";

const _ = cockpit.gettext;

/**
 * Return a CSS class name for the given ZFS state.
 * These classes are defined in storage.scss and use PatternFly design tokens.
 */
export function zfs_state_css_class(state) {
    switch (state) {
    case "ONLINE": return "zfs-state--online";
    case "DEGRADED": return "zfs-state--degraded";
    case "FAULTED": return "zfs-state--faulted";
    case "OFFLINE":
    case "REMOVED":
    case "UNAVAIL":
    case "UNKNOWN":
    default: return "zfs-state--offline";
    }
}

export function formatPoolGuid(guid) {
    if (!guid) return "";
    try {
        return "0x" + BigInt(guid).toString(16).toUpperCase();
    } catch (e) {
        return guid; // fallback to raw value
    }
}

export function fmt_zfs_state(state) {
    switch (state) {
    case "ONLINE": return _("Online");
    case "DEGRADED": return _("Degraded");
    case "FAULTED": return _("Faulted");
    case "OFFLINE": return _("Offline");
    case "REMOVED": return _("Removed");
    case "UNAVAIL": return _("Unavailable");
    case "UNKNOWN": return _("Unknown");
    default: return state || _("Unknown");
    }
}

/**
 * Format a dedup ratio (D-Bus type 'd' / double) for display.
 * Example: 1.0 -> "1.00x", 2.5 -> "2.50x"
 */
export function fmt_dedup_ratio(ratio) {
    if (ratio == null || isNaN(ratio))
        return "-";
    return Number(ratio).toFixed(2) + "x";
}

/**
 * Format fragmentation (D-Bus type 't' / uint64, percentage) for display.
 * Example: 5 -> "5%", 0 -> "0%"
 */
export function fmt_fragmentation(frag) {
    if (frag == null || isNaN(frag))
        return "-";
    return Number(frag) + "%";
}
