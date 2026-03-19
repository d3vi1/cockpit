/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Storage topology graph using plain SVG + Dagre layout.
 *
 * Replaces the @patternfly/react-topology approach which has a confirmed
 * bug where it fails to render components for ~50% of nodes when the
 * model exceeds ~14 nodes.  This version uses @dagrejs/dagre directly
 * for layout computation and renders everything with plain React SVG.
 * No MobX, no Visualization controller, no fromModel.
 */

import cockpit from "cockpit";
const _ = cockpit.gettext;
import React, { useEffect, useRef, useState, useCallback } from "react";
import dagre from "@dagrejs/dagre";
import client from "../client";

import { buildTopologyModel, fetchAsyncTopologyData } from "./topology-builder.js";
import { getIconForType, statusStrokeColor } from "./topology-node.jsx";

/* -- constants ------------------------------------------------------- */

const NODE_SEP = 220; /* horizontal spacing for compactXAxis */
const MIN_SCALE = 0.2;
const MAX_SCALE = 3.0;
const ZOOM_FACTOR = 1.3;

/* -- colors (PF design tokens with fallbacks) ----------------------- */

const FILL_COLOR = 'var(--pf-t--global--background--color--primary--default, #fff)';
const TEXT_COLOR = 'var(--pf-t--global--text--color--regular, #151515)';
const BADGE_COLOR = 'var(--pf-t--global--text--color--subtle, #6a6e73)';
const ICON_COLOR = 'var(--pf-t--global--icon--color--regular, #6a6e73)';
const EDGE_COLOR = 'var(--pf-t--global--border--color--default, #8a8d90)';
const FONT_FAMILY = 'var(--pf-t--global--font--family--text, RedHatText, Overpass, overpass, helvetica, arial, sans-serif)';

/* -- post-layout compaction ----------------------------------------- */

/**
 * Horizontally center pool member (disk) nodes beneath their pool,
 * and vertically align all disk-row nodes to the same Y.
 */
function compactXAxis(positioned, poolMembers) {
    const nodeById = new Map();
    for (const n of positioned.nodes) nodeById.set(n.id, n);

    for (const [poolId, memberIds] of poolMembers) {
        const poolNode = nodeById.get(poolId);
        if (!poolNode) continue;
        const poolCenterX = poolNode.x + poolNode.width / 2;
        const memberNodes = [];
        for (const mid of memberIds) {
            const mn = nodeById.get(mid);
            if (mn) memberNodes.push(mn);
        }
        if (memberNodes.length === 0) continue;
        memberNodes.sort((a, b) => a.x - b.x);
        const totalWidth = (memberNodes.length - 1) * NODE_SEP;
        const startX = poolCenterX - totalWidth / 2 - memberNodes[0].width / 2;
        for (let i = 0; i < memberNodes.length; i++) {
            memberNodes[i].x = startX + i * NODE_SEP;
        }
    }

    /* Align all disk-row nodes to the same minimum Y */
    const diskNodes = positioned.nodes.filter(n => n.data?.nodeType === 'disk');
    if (diskNodes.length > 0) {
        const minDiskY = Math.min(...diskNodes.map(n => n.y));
        for (const dn of diskNodes) {
            dn.y = minDiskY;
        }
    }

    /* Collision resolution: ensure no horizontal overlap between nodes at the same y */
    const nodesByY = new Map();
    for (const n of positioned.nodes) {
        const key = Math.round(n.y);
        if (!nodesByY.has(key)) nodesByY.set(key, []);
        nodesByY.get(key).push(n);
    }
    for (const [, row] of nodesByY) {
        row.sort((a, b) => a.x - b.x);
        for (let i = 1; i < row.length; i++) {
            const prev = row[i - 1];
            const curr = row[i];
            const minX = prev.x + prev.width + 20; // 20px gap
            if (curr.x < minX) {
                curr.x = minX;
            }
        }
    }
}

/* -- dagre layout computation --------------------------------------- */

function runDagreLayout(model) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: 'TB',
        nodesep: 80,
        edgesep: 40,
        ranksep: 120,
        marginx: 60,
        marginy: 60,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of model.nodes) {
        g.setNode(node.id, { label: node.label, width: node.width, height: node.height });
    }
    for (const edge of model.edges) {
        g.setEdge(edge.source, edge.target);
    }

    dagre.layout(g);

    const positioned = {
        nodes: model.nodes.map(n => {
            const pos = g.node(n.id);
            return {
                ...n,
                /* dagre returns center coordinates; convert to top-left */
                x: pos.x - n.width / 2,
                y: pos.y - n.height / 2,
            };
        }),
        edges: model.edges.map(e => {
            const edgeData = g.edge(e.source, e.target);
            return {
                ...e,
                points: edgeData ? edgeData.points : [],
            };
        }),
        graphWidth: g.graph().width || 0,
        graphHeight: g.graph().height || 0,
    };

    /* Post-layout compaction */
    if (model._poolMembers) {
        compactXAxis(positioned, model._poolMembers);

        /* Recompute edge paths from updated node positions.
         * compactXAxis moves nodes but the dagre edge waypoints still
         * reference pre-compaction coordinates.  Rebuild each edge as a
         * straight line from source bottom-center to target top-center. */
        const nodePositionMap = new Map();
        for (const n of positioned.nodes) {
            nodePositionMap.set(n.id, {
                x: n.x + n.width / 2,   // center x
                topY: n.y,               // top edge
                bottomY: n.y + n.height, // bottom edge
            });
        }

        positioned.edges = model.edges.map(e => {
            const src = nodePositionMap.get(e.source);
            const tgt = nodePositionMap.get(e.target);
            if (!src || !tgt) return null;
            return {
                ...e,
                points: [
                    { x: src.x, y: src.bottomY },
                    { x: tgt.x, y: tgt.topY },
                ],
            };
        }).filter(Boolean);

        /* Recompute graph bounds after compaction */
        let maxX = 0;
        let maxY = 0;
        for (const n of positioned.nodes) {
            const right = n.x + n.width;
            const bottom = n.y + n.height;
            if (right > maxX) maxX = right;
            if (bottom > maxY) maxY = bottom;
        }
        positioned.graphWidth = maxX + 60; /* margin */
        positioned.graphHeight = maxY + 60;
    }

    return positioned;
}

/* -- SVG edge path builder ------------------------------------------ */

function edgePath(points) {
    if (!points || points.length === 0) return "";
    let d = `M${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
        d += ` L${points[i].x},${points[i].y}`;
    }
    return d;
}

/* -- single node component ------------------------------------------ */

const TopologyNode = ({ node }) => {
    const data = node.data || {};
    const Icon = getIconForType(data.nodeType);
    const status = data.status || 'default';
    const badge = data.badge || "";
    const strokeColor = statusStrokeColor(status);
    const strokeWidth = status !== 'default' ? 2.5 : 1.5;

    function onNodeClick() {
        if (data.navigateTo) {
            cockpit.location.go(data.navigateTo);
        }
    }

    return (
        <g
            transform={`translate(${node.x},${node.y})`}
            onDoubleClick={onNodeClick}
            className="topology-node"
            style={{ cursor: data.navigateTo ? 'pointer' : 'default' }}
        >
            <rect
                rx={6}
                ry={6}
                width={node.width}
                height={node.height}
                fill={FILL_COLOR}
                stroke={strokeColor}
                strokeWidth={strokeWidth}
            />
            <foreignObject width={node.width} height={node.height}>
                <div
                    xmlns="http://www.w3.org/1999/xhtml"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '0 8px',
                        height: '100%',
                        fontSize: 12,
                        fontFamily: FONT_FAMILY,
                        color: ICON_COLOR,
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {Icon && <Icon />}
                    <span
                        style={{
                            fontWeight: 600,
                            color: TEXT_COLOR,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            flexShrink: 1,
                            minWidth: 0,
                        }}
                    >
                        {node.label}
                    </span>
                    {badge && (
                        <span
                            style={{
                                fontSize: 11,
                                color: BADGE_COLOR,
                                flexShrink: 0,
                                marginLeft: 'auto',
                            }}
                        >
                            {badge}{data.secondaryLabel ? ` \u00b7 ${data.secondaryLabel}` : ''}
                        </span>
                    )}
                </div>
            </foreignObject>
        </g>
    );
};

/* -- main graph component ------------------------------------------- */

export const TopologyGraph = () => {
    const [asyncData, setAsyncData] = useState(null);
    const [layout, setLayout] = useState(null);
    const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
    const svgRef = useRef(null);
    const debounceTimer = useRef(null);
    const isPanning = useRef(false);
    const panStart = useRef({ x: 0, y: 0 });
    const transformAtPanStart = useRef({ x: 0, y: 0 });

    /* Fetch async ZFS data on mount and re-fetch on client changes */
    useEffect(() => {
        let cancelled = false;
        fetchAsyncTopologyData(client).then(data => {
            if (!cancelled) setAsyncData(data);
        });
        function onChanged() {
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
            debounceTimer.current = setTimeout(() => {
                fetchAsyncTopologyData(client).then(data => {
                    if (!cancelled) setAsyncData(data);
                });
            }, 2000);
        }
        client.addEventListener("changed", onChanged);
        return () => {
            cancelled = true;
            client.removeEventListener("changed", onChanged);
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
    }, []);

    /* Build model + run dagre layout when async data is ready */
    useEffect(() => {
        if (!asyncData) return;
        try {
            const model = buildTopologyModel(client, asyncData);
            const positioned = runDagreLayout(model);
            setLayout(positioned);
        } catch (e) {
            console.warn("topology: layout computation failed:", e);
        }
    }, [asyncData]);

    /* Fit-to-view helper */
    const fitToView = useCallback(() => {
        if (!layout || !svgRef.current) return;
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();
        const svgW = rect.width;
        const svgH = rect.height;
        if (svgW === 0 || svgH === 0) return;

        const padX = 40;
        const padY = 40;
        const scaleX = (svgW - padX * 2) / layout.graphWidth;
        const scaleY = (svgH - padY * 2) / layout.graphHeight;
        const scale = Math.max(Math.min(Math.min(scaleX, scaleY), 1.0), 0.3);

        setTransform({
            x: (svgW - layout.graphWidth * scale) / 2,
            y: (svgH - layout.graphHeight * scale) / 2,
            scale,
        });
    }, [layout]);

    /* Fit on first layout */
    useEffect(() => {
        if (!layout) return;
        /* Delay briefly to ensure the container has its final dimensions */
        const timer = setTimeout(fitToView, 100);
        return () => clearTimeout(timer);
    }, [layout, fitToView]);

    /* Mouse wheel zoom */
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;

        function onWheel(e) {
            e.preventDefault();
            const rect = svg.getBoundingClientRect();
            /* Mouse position relative to SVG element */
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            setTransform(prev => {
                const direction = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
                const newScale = Math.min(Math.max(prev.scale * direction, MIN_SCALE), MAX_SCALE);
                /* Zoom toward mouse position */
                const scaleChange = newScale / prev.scale;
                const newX = mx - (mx - prev.x) * scaleChange;
                const newY = my - (my - prev.y) * scaleChange;
                return { x: newX, y: newY, scale: newScale };
            });
        }

        svg.addEventListener('wheel', onWheel, { passive: false });
        return () => svg.removeEventListener('wheel', onWheel);
    }, []);

    /* Pan handlers */
    function onMouseDown(e) {
        /* Only pan on left click, and not on a node */
        if (e.button !== 0) return;
        isPanning.current = true;
        panStart.current = { x: e.clientX, y: e.clientY };
        transformAtPanStart.current = { x: transform.x, y: transform.y };
        e.currentTarget.style.cursor = 'grabbing';
    }

    function onMouseMove(e) {
        if (!isPanning.current) return;
        const dx = e.clientX - panStart.current.x;
        const dy = e.clientY - panStart.current.y;
        setTransform(prev => ({
            ...prev,
            x: transformAtPanStart.current.x + dx,
            y: transformAtPanStart.current.y + dy,
        }));
    }

    function onMouseUp(e) {
        if (isPanning.current) {
            isPanning.current = false;
            if (e.currentTarget) e.currentTarget.style.cursor = '';
        }
    }

    function onMouseLeave(e) {
        if (isPanning.current) {
            isPanning.current = false;
            if (e.currentTarget) e.currentTarget.style.cursor = '';
        }
    }

    /* Zoom button handlers */
    function zoomIn() {
        setTransform(prev => {
            const newScale = Math.min(prev.scale * ZOOM_FACTOR, MAX_SCALE);
            return { ...prev, scale: newScale };
        });
    }

    function zoomOut() {
        setTransform(prev => {
            const newScale = Math.max(prev.scale / ZOOM_FACTOR, MIN_SCALE);
            return { ...prev, scale: newScale };
        });
    }

    if (!layout) {
        return <div className="storage-topology-container topology-loading">{_("Loading...")}</div>;
    }

    return (
        <div className="storage-topology-container">
            <svg
                ref={svgRef}
                className="topology-svg"
                width="100%"
                height="100%"
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseLeave}
            >
                <g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
                    {/* Edges (render first so they appear behind nodes) */}
                    {layout.edges.map(e => (
                        <path
                            key={e.id}
                            d={edgePath(e.points)}
                            fill="none"
                            stroke={EDGE_COLOR}
                            strokeWidth={1.5}
                        />
                    ))}
                    {/* Nodes */}
                    {layout.nodes.map(n => (
                        <TopologyNode key={n.id} node={n} />
                    ))}
                </g>
            </svg>
            {/* Zoom / fit controls */}
            <div className="topology-controls">
                <button className="topology-control-btn" onClick={zoomIn} title={_("Zoom in")}>+</button>
                <button className="topology-control-btn" onClick={zoomOut} title={_("Zoom out")}>&minus;</button>
                <button className="topology-control-btn" onClick={fitToView} title={_("Fit to view")}>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                        <path d="M2 2v4h1.5V3.5H6V2H2zm8 0v1.5h2.5V6H14V2h-4zM3.5 10.5V13H6v1.5H2V10h1.5zm9 0V13h-2.5v1.5H14V10h-1.5z" />
                    </svg>
                </button>
            </div>
        </div>
    );
};

export default TopologyGraph;
