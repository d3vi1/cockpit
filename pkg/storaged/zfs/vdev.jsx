/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";
import React, { useState, useEffect, useCallback } from "react";
import client from "../client";

import { CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Badge } from "@patternfly/react-core/dist/esm/components/Badge/index.js";
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';

import { StorageCard } from "../pages.jsx";
import { zfs_pool_state_color, fmt_zfs_state } from "./utils.jsx";

const _ = cockpit.gettext;

function parse_vdev(v) {
    return {
        path: v.path?.v || "",
        type: v.type?.v || "",
        state: v.state?.v || "UNKNOWN",
        read_errors: Number(v.read_errors?.v || 0),
        write_errors: Number(v.write_errors?.v || 0),
        checksum_errors: Number(v.checksum_errors?.v || 0),
        children: v.children?.v ? v.children.v.map(parse_vdev) : null,
    };
}

function vdev_type_label(type) {
    switch (type) {
    case "mirror": return _("Mirror");
    case "raidz": return _("RAIDZ");
    case "raidz1": return _("RAIDZ1");
    case "raidz2": return _("RAIDZ2");
    case "raidz3": return _("RAIDZ3");
    case "spare": return _("Spare");
    case "cache": return _("Cache");
    case "log": return _("Log");
    case "special": return _("Special");
    case "dedup": return _("Dedup");
    default: return type;
    }
}

function renderVdev(vdev, depth, key_prefix) {
    const indent = depth * 24;
    const state_color = zfs_pool_state_color(vdev.state);
    const state_text = fmt_zfs_state(vdev.state);
    const display_name = vdev.path || vdev_type_label(vdev.type) || _("unknown");
    const has_errors = vdev.read_errors > 0 || vdev.write_errors > 0 || vdev.checksum_errors > 0;

    const rows = [];
    rows.push(
        <Tr key={key_prefix}>
            <Td style={{ paddingLeft: indent + "px" }}>
                {depth === 0 && vdev.type &&
                    <Badge isRead style={{ marginRight: "8px" }}>
                        {vdev_type_label(vdev.type)}
                    </Badge>
                }
                <span style={{ fontWeight: depth === 0 ? "bold" : "normal" }}>
                    {depth === 0 ? (vdev.path || vdev_type_label(vdev.type)) : display_name}
                </span>
            </Td>
            <Td>
                <span style={{ color: state_color }}>
                    {state_text}
                </span>
            </Td>
            <Td style={has_errors ? { color: "var(--pf-t--global--color--status--danger--default)" } : {}}>
                {vdev.read_errors}
            </Td>
            <Td style={has_errors ? { color: "var(--pf-t--global--color--status--danger--default)" } : {}}>
                {vdev.write_errors}
            </Td>
            <Td style={has_errors ? { color: "var(--pf-t--global--color--status--danger--default)" } : {}}>
                {vdev.checksum_errors}
            </Td>
        </Tr>
    );

    if (vdev.children) {
        vdev.children.forEach((child, idx) => {
            rows.push(...renderVdev(child, depth + 1, key_prefix + "-" + idx));
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
                    const parsed = result[0].map(parse_vdev);
                    setTopology(parsed);
                    setError(null);
                })
                .catch(err => {
                    console.warn("GetVdevTopology failed:", err);
                    setError(err.toString());
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
                { topology !== null && topology.length > 0 &&
                    <Table aria-label={_("ZFS vdev topology")} variant="compact">
                        <Thead>
                            <Tr>
                                <Th>{_("Device")}</Th>
                                <Th>{_("State")}</Th>
                                <Th>{_("Read errors")}</Th>
                                <Th>{_("Write errors")}</Th>
                                <Th>{_("Checksum errors")}</Th>
                            </Tr>
                        </Thead>
                        <Tbody>
                            { topology.flatMap((vdev, idx) => renderVdev(vdev, 0, "vdev-" + idx)) }
                        </Tbody>
                    </Table>
                }
            </CardBody>
        </StorageCard>
    );
};
