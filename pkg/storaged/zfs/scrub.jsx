/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";
import React from "react";
import client from "../client";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Progress, ProgressMeasureLocation } from "@patternfly/react-core/dist/esm/components/Progress/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";

import { StorageCard, StorageDescription } from "../pages.jsx";

const _ = cockpit.gettext;

export const ZFSScrubCard = ({ card, pool }) => {
    const pool_path = pool.path;
    const is_running = pool.ScrubRunning;
    const is_paused = pool.ScrubPaused;
    const progress = pool.ScrubProgress; // 0.0 - 1.0
    const errors = pool.ScrubErrors;

    function start_scrub() {
        return client.run(() => client.zfs_pool_call(pool_path, "StartScrub", [{}]));
    }

    function pause_scrub() {
        return client.run(() => client.zfs_pool_call(pool_path, "PauseScrub", [{}]));
    }

    function resume_scrub() {
        return client.run(() => client.zfs_pool_call(pool_path, "ResumeScrub", [{}]));
    }

    function stop_scrub() {
        return client.run(() => client.zfs_pool_call(pool_path, "StopScrub", [{}]));
    }

    function start_trim() {
        return client.run(() => client.zfs_pool_call(pool_path, "StartTrim", [{}]));
    }

    let status_text;
    let progress_variant;
    if (is_running && !is_paused) {
        status_text = cockpit.format(_("Running ($0%)"), (progress * 100).toFixed(1));
        progress_variant = undefined;
    } else if (is_running && is_paused) {
        status_text = cockpit.format(_("Paused at $0%"), (progress * 100).toFixed(1));
        progress_variant = "warning";
    } else {
        status_text = _("Not running");
        progress_variant = undefined;
    }

    const scrub_buttons = [];
    if (!is_running) {
        scrub_buttons.push(
            <Button key="start" variant="secondary" size="sm"
                    onClick={start_scrub}>
                {_("Start scrub")}
            </Button>
        );
    } else if (is_paused) {
        scrub_buttons.push(
            <Button key="resume" variant="secondary" size="sm"
                    onClick={resume_scrub}>
                {_("Resume")}
            </Button>
        );
        scrub_buttons.push(
            <Button key="stop" variant="secondary" size="sm"
                    onClick={stop_scrub}>
                {_("Stop")}
            </Button>
        );
    } else {
        scrub_buttons.push(
            <Button key="pause" variant="secondary" size="sm"
                    onClick={pause_scrub}>
                {_("Pause")}
            </Button>
        );
        scrub_buttons.push(
            <Button key="stop" variant="secondary" size="sm"
                    onClick={stop_scrub}>
                {_("Stop")}
            </Button>
        );
    }

    return (
        <StorageCard card={card}>
            <CardBody>
                <DescriptionList className="pf-m-horizontal-on-sm">
                    <StorageDescription title={_("Status")} value={status_text} />
                    { is_running &&
                      <StorageDescription title={_("Progress")}>
                          <Progress value={progress * 100}
                                    measureLocation={ProgressMeasureLocation.outside}
                                    variant={progress_variant}
                                    aria-label={_("Scrub progress")} />
                      </StorageDescription>
                    }
                    { errors > 0 &&
                      <StorageDescription title={_("Errors")}>
                          <Alert variant="warning" isInline isPlain
                                 title={cockpit.format(_("$0 errors found during scrub"), errors)} />
                      </StorageDescription>
                    }
                    <StorageDescription title={_("Controls")}>
                        <Flex spaceItems={{ default: 'spaceItemsSm' }}>
                            { scrub_buttons.map(btn => (
                                <FlexItem key={btn.key}>{btn}</FlexItem>
                            )) }
                            <FlexItem>
                                <Button variant="secondary" size="sm"
                                        onClick={start_trim}>
                                    {_("Start trim")}
                                </Button>
                            </FlexItem>
                        </Flex>
                    </StorageDescription>
                </DescriptionList>
            </CardBody>
        </StorageCard>
    );
};
