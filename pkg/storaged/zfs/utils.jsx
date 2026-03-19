/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";

const _ = cockpit.gettext;

export function zfs_pool_state_color(state) {
    switch (state) {
    case "ONLINE": return "green";
    case "DEGRADED": return "orange";
    case "FAULTED": return "red";
    case "OFFLINE":
    case "REMOVED":
    case "UNAVAIL":
    case "UNKNOWN":
    default: return "grey";
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
