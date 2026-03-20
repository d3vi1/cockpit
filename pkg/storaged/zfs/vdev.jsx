/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";
import React, { useState, useEffect, useCallback } from "react";
import client from "../client";

import { CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { StorageCard } from "../pages.jsx";
import { StorageBarMenu, StorageMenuItem } from "../storage-controls.jsx";
import { zfs_state_css_class, fmt_zfs_state } from "./utils.jsx";
import {
    replace_zfs_vdev, attach_zfs_vdev, detach_zfs_vdev,
    online_zfs_vdev, offline_zfs_vdev,
} from "./dialogs.jsx";

const _ = cockpit.gettext;

/* Unwrap D-Bus variant values: Cockpit's D-Bus client may deliver
 * a{sv} dictionary entries as either raw values or {v: <value>}
 * wrappers depending on the nesting level.  This helper normalises
 * both forms so callers can always work with the plain value. */
function unwrap(val) {
    if (val && typeof val === 'object' && 'v' in val)
        return val.v;
    return val;
}

function parse_vdev(v) {
    if (!v || typeof v !== 'object')
        return { path: "", type: "", state: "UNKNOWN", read_errors: 0, write_errors: 0, checksum_errors: 0, children: null };

    const raw_children = unwrap(v.children);
    let children = null;
    if (Array.isArray(raw_children) && raw_children.length > 0)
        children = raw_children.filter(c => c != null).map(parse_vdev);

    return {
        path: unwrap(v.path) || "",
        type: unwrap(v.type) || "",
        state: unwrap(v.state) || "UNKNOWN",
        read_errors: Number(unwrap(v.read_errors)) || 0,
        write_errors: Number(unwrap(v.write_errors)) || 0,
        checksum_errors: Number(unwrap(v.checksum_errors)) || 0,
        children: (children && children.length > 0) ? children : null,
    };
}

function vdev_type_label(type) {
    switch (type) {
    case "mirror": return _("Mirror");
    case "raidz": return _("RAIDZ");
    case "raidz1": return _("RAIDZ1");
    case "raidz2": return _("RAIDZ2");
    case "raidz3": return _("RAIDZ3");
    case "draid": return _("dRAID");
    case "spare": return _("Spare");
    case "cache": return _("Cache");
    case "log": return _("Log");
    case "special": return _("Special");
    case "dedup": return _("Dedup");
    default: return type;
    }
}

/* Special vdev classes where mirror-attach is not applicable */
const SPECIAL_VDEV_CLASSES = new Set(["spare", "cache"]);

/* Parity-group vdev types — members cannot be individually attached/detached */
const PARITY_GROUP_TYPES = new Set(["raidz", "raidz1", "raidz2", "raidz3", "draid"]);

function vdev_actions_menu(pool, vdev, parent_vdev) {
    // Only show actions for actual leaf devices — nodes that represent a
    // physical disk/file and have no children.  Aggregate nodes (mirror-0,
    // raidz1-0, etc.) carry a truthy `path` token but are not actionable.
    const is_leaf = !vdev.children || vdev.children.length === 0;
    if (!is_leaf || !vdev.path)
        return null;

    const parent_type = parent_vdev?.type || "";
    const is_in_mirror = parent_type === "mirror";
    const is_in_parity_group = PARITY_GROUP_TYPES.has(parent_type);
    const is_in_special_class = SPECIAL_VDEV_CLASSES.has(parent_type);
    const is_spare = parent_type === "spare";
    const is_offline = vdev.state === "OFFLINE";

    const items = [];

    // Spares are passive — no online/offline toggling
    if (!is_spare) {
        if (is_offline) {
            items.push(
                <StorageMenuItem key="online"
                                 onClick={() => online_zfs_vdev(pool, vdev.path)}>
                    {_("Online")}
                </StorageMenuItem>
            );
        } else {
            items.push(
                <StorageMenuItem key="offline"
                                 onClick={() => offline_zfs_vdev(pool, vdev.path)}>
                    {_("Offline")}
                </StorageMenuItem>
            );
        }
    }

    items.push(
        <StorageMenuItem key="replace"
                         onClick={() => replace_zfs_vdev(pool, vdev.path)}>
            {_("Replace")}
        </StorageMenuItem>
    );

    // Attach mirror: not applicable in spare/cache vdev classes or inside parity groups
    if (!is_in_special_class && !is_in_parity_group) {
        items.push(
            <StorageMenuItem key="attach"
                             onClick={() => attach_zfs_vdev(pool, vdev.path)}>
                {_("Attach mirror")}
            </StorageMenuItem>
        );
    }

    if (is_in_mirror) {
        items.push(
            <StorageMenuItem key="detach"
                             onClick={() => detach_zfs_vdev(pool, vdev.path)}>
                {_("Detach")}
            </StorageMenuItem>
        );
    }

    if (items.length === 0)
        return null;

    return <StorageBarMenu label={_("Actions")} isKebab menuItems={items} />;
}

function renderVdev(pool, vdev, depth, key_prefix, parent_vdev) {
    const state_css = zfs_state_css_class(vdev.state);
    const state_text = fmt_zfs_state(vdev.state);
    const is_aggregate = vdev.children && vdev.children.length > 0;
    // Aggregate rows (mirror-0, raidz1-0, etc.) show the human-readable type
    // label; leaf rows show the device path.
    const display_name = is_aggregate
        ? vdev_type_label(vdev.type) || vdev.path || _("Unknown device")
        : vdev.path || vdev_type_label(vdev.type) || _("Unknown device");
    const has_errors = vdev.read_errors > 0 || vdev.write_errors > 0 || vdev.checksum_errors > 0;
    const error_class = has_errors ? "zfs-vdev-error" : undefined;

    const rows = [];
    rows.push(
        <Tr key={key_prefix}>
            <Td className="zfs-vdev-indent" style={{ "--zfs-vdev-level": depth }}>
                <span className={depth === 0 ? "pf-v6-u-font-weight-bold" : undefined}>
                    {display_name}
                </span>
            </Td>
            <Td>
                <span className={"zfs-state-text " + state_css}>
                    {state_text}
                </span>
            </Td>
            <Td className={error_class}>
                {vdev.read_errors}
            </Td>
            <Td className={error_class}>
                {vdev.write_errors}
            </Td>
            <Td className={error_class}>
                {vdev.checksum_errors}
            </Td>
            <Td isActionCell>
                {vdev_actions_menu(pool, vdev, parent_vdev)}
            </Td>
        </Tr>
    );

    if (vdev.children) {
        vdev.children.forEach((child, idx) => {
            rows.push(...renderVdev(pool, child, depth + 1, key_prefix + "-" + idx, vdev));
        });
    }

    return rows;
}

export const ZFSVdevCard = ({ card, pool }) => {
    const pool_path = pool.path;
    const [topology, setTopology] = useState(null);
    const [error, setError] = useState(null);

    const refresh = useCallback(() => {
        client.zfs_pool_call(pool_path, "GetVdevTopology", [{}])
                .then(result => {
                    const raw = Array.isArray(result) ? result[0] : result;
                    const arr = Array.isArray(raw) ? raw : [];
                    const parsed = arr.filter(v => v != null).map(parse_vdev);
                    setTopology(parsed);
                    setError(null);
                })
                .catch(err => {
                    setError(err.toString());
                    setTopology(null);
                });
    }, [pool_path]);

    useEffect(() => {
        refresh();

        function on_changed() {
            refresh();
        }
        client.addEventListener("changed", on_changed);
        return () => client.removeEventListener("changed", on_changed);
    }, [refresh]);

    return (
        <StorageCard card={card}>
            <CardBody className="contains-list">
                { error &&
                    <Alert variant="danger" isInline title={_("Failed to load vdev topology")}>
                        {error}
                    </Alert>
                }
                { topology === null && !error &&
                    <EmptyState>
                        <Spinner size="lg" />
                        <EmptyStateBody>{_("Loading vdev topology...")}</EmptyStateBody>
                    </EmptyState>
                }
                { topology !== null && topology.length === 0 && !error &&
                    <EmptyState>
                        <EmptyStateBody>{_("No vdev information available")}</EmptyStateBody>
                    </EmptyState>
                }
                { topology !== null && topology.length > 0 && !error &&
                    <Table aria-label={_("ZFS vdev topology")} variant="compact">
                        <Thead>
                            <Tr>
                                <Th>{_("Device")}</Th>
                                <Th>{_("State")}</Th>
                                <Th>{_("Read errors")}</Th>
                                <Th>{_("Write errors")}</Th>
                                <Th>{_("Checksum errors")}</Th>
                                <Th />
                            </Tr>
                        </Thead>
                        <Tbody>
                            { topology.flatMap((vdev, idx) => renderVdev(pool, vdev, 0, "vdev-" + idx, null)) }
                        </Tbody>
                    </Table>
                }
            </CardBody>
        </StorageCard>
    );
};
