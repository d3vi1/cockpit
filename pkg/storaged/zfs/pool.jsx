/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";
import React from "react";
import client from "../client";

import { CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import { VolumeIcon } from "../icons/gnome-icons.jsx";

import {
    new_card, new_page, PAGE_CATEGORY_VIRTUAL,
    StorageCard, StorageDescription,
} from "../pages.jsx";
import { StorageUsageBar } from "../storage-controls.jsx";
import { fmt_size_long } from "../utils.js";
import { fmt_zfs_state, zfs_state_css_class, formatPoolGuid, fmt_dedup_ratio, fmt_fragmentation } from "./utils.jsx";
import { ZFSDatasetsCard, create_filesystem, create_volume, create_snapshot } from "./datasets.jsx";
import { ZFSVdevCard } from "./vdev.jsx";
import {
    export_zfs_pool, destroy_zfs_pool,
    clear_errors_zfs_pool, upgrade_zfs_pool,
    view_history_zfs_pool, view_edit_pool_properties, add_vdev_to_pool,
} from "./dialogs.jsx";

const _ = cockpit.gettext;

export function make_zfs_pool_page(parent, pool) {
    const use = [Number(pool.Allocated), Number(pool.Size)];

    const pool_actions = [];

    // Scrub actions (contextual)
    if (pool.ScrubRunning && !pool.ScrubPaused) {
        // CanScrubPause is a boolean D-Bus property that indicates whether
        // the installed OpenZFS version supports "zpool scrub -p" (0.8.0+).
        if (pool.CanScrubPause) {
            pool_actions.push({
                title: _("Pause scrub"),
                action: () => client.run(() => client.zfs_pool_call(pool.path, "ScrubPause", [{}])),
            });
        }
        pool_actions.push({
            title: _("Stop scrub"),
            action: () => client.run(() => client.zfs_pool_call(pool.path, "ScrubStop", [{}])),
        });
    } else if (pool.ScrubRunning && pool.ScrubPaused) {
        pool_actions.push({
            title: _("Resume scrub"),
            action: () => client.run(() => client.zfs_pool_call(pool.path, "ScrubStart", [{}])),
        });
        pool_actions.push({
            title: _("Stop scrub"),
            action: () => client.run(() => client.zfs_pool_call(pool.path, "ScrubStop", [{}])),
        });
    } else {
        pool_actions.push({
            title: _("Start scrub"),
            action: () => client.run(() => client.zfs_pool_call(pool.path, "ScrubStart", [{}])),
        });
    }

    // Trim actions — only show when the backend reports trim capability.
    // CanTrim is a boolean D-Bus property that accounts for both the
    // OpenZFS version (0.8.0+) and the pool's device_trim feature state.
    if (pool.CanTrim) {
        // No TrimRunning property is available from the backend yet,
        // so we can only offer "Start trim" (never "Stop trim").
        // Disable while a scrub is running — these compete for I/O.
        if (!pool.ScrubRunning) {
            pool_actions.push({
                title: _("Start trim"),
                action: () => client.run(() => client.zfs_pool_call(pool.path, "TrimStart", [{}])),
            });
        }
    }

    // Pool management actions
    pool_actions.push({
        title: _("Clear errors"),
        action: () => clear_errors_zfs_pool(pool),
    });
    pool_actions.push({
        title: _("View history"),
        action: () => view_history_zfs_pool(pool),
    });
    pool_actions.push({
        title: _("View properties"),
        action: () => view_edit_pool_properties(pool),
    });

    pool_actions.push({
        title: _("Add vdev"),
        action: () => add_vdev_to_pool(pool),
    });

    pool_actions.push({
        title: _("Export pool"),
        action: () => export_zfs_pool(pool, pool_card),
    });

    pool_actions.push({
        title: _("Upgrade pool"),
        action: () => upgrade_zfs_pool(pool),
        danger: true,
    });

    pool_actions.push({
        title: _("Destroy pool"),
        action: () => destroy_zfs_pool(pool, pool_card),
        danger: true,
    });

    const pool_card = new_card({
        title: _("ZFS pool"),
        next: null,
        page_location: ["zpool", pool.Name],
        page_name: pool.Name,
        page_icon: VolumeIcon,
        page_category: PAGE_CATEGORY_VIRTUAL,
        page_size: (use[1]
            ? <StorageUsageBar key="s" stats={use} short />
            : Number(pool.Size)),
        job_path: pool.path,
        component: ZFSPoolCard,
        props: { pool, use },
        actions: pool_actions,
    });

    const vdev_card = new_card({
        title: _("ZFS vdev topology"),
        next: pool_card,
        component: ZFSVdevCard,
        props: { pool },
    });

    const datasets_card = new_card({
        title: _("ZFS datasets"),
        next: vdev_card,
        component: ZFSDatasetsCard,
        props: { pool },
        actions: [
            {
                title: _("Create filesystem"),
                action: () => create_filesystem(pool.path, pool.Name),
            },
            {
                title: _("Create volume"),
                action: () => create_volume(pool.path, pool.Name),
            },
            {
                title: _("Create snapshot"),
                action: () => create_snapshot(pool.path, pool.Name),
            },
        ],
    });

    new_page(parent, datasets_card);
}

const ZFSPoolCard = ({ card, pool, use }) => {
    const state_css = zfs_state_css_class(pool.State);
    const state_text = fmt_zfs_state(pool.State);
    const health_text = fmt_zfs_state(pool.Health);

    // Scrub status
    let scrub_status;
    if (pool.ScrubRunning && !pool.ScrubPaused) {
        scrub_status = cockpit.format(_("Running ($0%)"), (pool.ScrubProgress * 100).toFixed(1));
    } else if (pool.ScrubRunning && pool.ScrubPaused) {
        scrub_status = cockpit.format(_("Paused ($0%)"), (pool.ScrubProgress * 100).toFixed(1));
    } else if (pool.ScrubErrors > 0) {
        scrub_status = cockpit.format(_("$0 errors found"), pool.ScrubErrors);
    } else {
        scrub_status = null;
    }

    return (
        <StorageCard card={card}>
            <CardBody>
                <DescriptionList className="pf-m-horizontal-on-sm">
                    <StorageDescription title={_("Name")} value={pool.Name} />
                    <StorageDescription title={_("GUID")} value={formatPoolGuid(pool.GUID)} />
                    <StorageDescription title={_("State")}>
                        <Flex spaceItems={{ default: 'spaceItemsSm' }}>
                            <FlexItem>
                                <span className={"zfs-state-dot " + state_css}>&#x2B24;</span>
                            </FlexItem>
                            <FlexItem>
                                {state_text}
                            </FlexItem>
                        </Flex>
                    </StorageDescription>
                    <StorageDescription title={_("Health")} value={health_text} />
                    <StorageDescription title={_("Capacity")} value={fmt_size_long(Number(pool.Size))} />
                    <StorageDescription title={_("Usage")}>
                        <StorageUsageBar key="s" stats={use} />
                    </StorageDescription>
                    <StorageDescription title={_("Dedup ratio")} value={fmt_dedup_ratio(pool.DedupRatio)} />
                    <StorageDescription title={_("Fragmentation")} value={fmt_fragmentation(pool.Fragmentation)} />
                    <StorageDescription title={_("Read only")} value={pool.ReadOnly ? _("Yes") : _("No")} />
                    { pool.Altroot && pool.Altroot !== "-" &&
                    <StorageDescription title={_("Alternate root")} value={pool.Altroot} />
                    }
                    { scrub_status &&
                    <StorageDescription title={_("Scrub status")} value={scrub_status} />
                    }
                </DescriptionList>
            </CardBody>
        </StorageCard>
    );
};
