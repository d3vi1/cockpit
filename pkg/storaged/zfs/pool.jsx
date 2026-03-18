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
import { Badge } from "@patternfly/react-core/dist/esm/components/Badge/index.js";

import { VolumeIcon } from "../icons/gnome-icons.jsx";

import {
    new_card, new_page, PAGE_CATEGORY_VIRTUAL,
    StorageCard, StorageDescription,
} from "../pages.jsx";
import { StorageUsageBar } from "../storage-controls.jsx";
import { fmt_size_long } from "../utils.js";
import { fmt_zfs_state, zfs_pool_state_color, formatPoolGuid } from "./utils.jsx";
import { ZFSDatasetsCard, create_filesystem, create_volume, create_snapshot } from "./datasets.jsx";
import { ZFSVdevCard } from "./vdev.jsx";
import { export_zfs_pool, destroy_zfs_pool, load_zfs_key, unload_zfs_key } from "./dialogs.jsx";

const _ = cockpit.gettext;

export function make_zfs_pool_page(parent, pool) {
    const use = [Number(pool.Allocated), Number(pool.Size)];

    const pool_actions = [];

    // Scrub actions (contextual)
    if (pool.ScrubRunning && !pool.ScrubPaused) {
        pool_actions.push({
            title: _("Pause scrub"),
            action: () => client.run(() => client.zfs_pool_call(pool.path, "PauseScrub", [{}])),
        });
        pool_actions.push({
            title: _("Stop scrub"),
            action: () => client.run(() => client.zfs_pool_call(pool.path, "StopScrub", [{}])),
        });
    } else if (pool.ScrubRunning && pool.ScrubPaused) {
        pool_actions.push({
            title: _("Resume scrub"),
            action: () => client.run(() => client.zfs_pool_call(pool.path, "ResumeScrub", [{}])),
        });
        pool_actions.push({
            title: _("Stop scrub"),
            action: () => client.run(() => client.zfs_pool_call(pool.path, "StopScrub", [{}])),
        });
    } else {
        pool_actions.push({
            title: _("Start scrub"),
            action: () => client.run(() => client.zfs_pool_call(pool.path, "StartScrub", [{}])),
        });
    }

    // Trim action
    pool_actions.push({
        title: _("Start trim"),
        action: () => client.run(() => client.zfs_pool_call(pool.path, "StartTrim", [{}])),
    });

    pool_actions.push({
        title: _("Export pool"),
        action: () => export_zfs_pool(pool),
    });

    // Add encryption key actions if pool has encryption info
    if (pool.Encryption && pool.Encryption !== "off") {
        if (pool.KeyLoaded) {
            pool_actions.push({
                title: _("Unload encryption key"),
                action: () => unload_zfs_key(pool),
            });
        } else {
            pool_actions.push({
                title: _("Load encryption key"),
                action: () => load_zfs_key(pool),
            });
        }
    }

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
        title: _("ZFS pool"),
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
    const state_color = zfs_pool_state_color(pool.State);
    const state_text = fmt_zfs_state(pool.State);
    const health_text = fmt_zfs_state(pool.Health);

    const has_encryption = pool.Encryption && pool.Encryption !== "off";

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
                                <span style={{ color: state_color }}>&#x2B24;</span>
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
                    <StorageDescription title={_("Dedup ratio")} value={pool.DedupRatio} />
                    <StorageDescription title={_("Fragmentation")} value={pool.Fragmentation} />
                    <StorageDescription title={_("Read only")} value={pool.ReadOnly ? _("Yes") : _("No")} />
                    { pool.Altroot && pool.Altroot !== "-" &&
                    <StorageDescription title={_("Alternate root")} value={pool.Altroot} />
                    }
                    { has_encryption &&
                    <StorageDescription title={_("Encryption")}>
                        <Flex spaceItems={{ default: 'spaceItemsSm' }}>
                            <FlexItem>{pool.Encryption}</FlexItem>
                            <FlexItem>
                                <Badge isRead={!pool.KeyLoaded}>
                                    {pool.KeyLoaded ? _("Key loaded") : _("Key not loaded")}
                                </Badge>
                            </FlexItem>
                        </Flex>
                    </StorageDescription>
                    }
                    { scrub_status &&
                    <StorageDescription title={_("Scrub status")} value={scrub_status} />
                    }
                </DescriptionList>
            </CardBody>
        </StorageCard>
    );
};
