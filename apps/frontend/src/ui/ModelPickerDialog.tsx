import React, { useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ModelInfo, ModelProviderInfo } from "@openharness/client";

import { useTheme } from "../theme/ThemeContext";
import { AC_VISIBLE_ITEMS } from "./constants";

type Row =
  | { kind: "provider"; key: string; label: string }
  | { kind: "model"; key: string; provider: ModelProviderInfo; model: ModelInfo };

function matches(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

function modelSearchText(provider: ModelProviderInfo, model: ModelInfo): string {
  return [
    provider.displayName,
    provider.name,
    model.label,
    model.id,
    model.hint ?? "",
  ].join(" ");
}

function buildRows(providers: ModelProviderInfo[], query: string): Row[] {
  const rows: Row[] = [];
  for (const provider of providers) {
    const providerMatches = matches(`${provider.displayName} ${provider.name}`, query);
    const models = query
      ? provider.models.filter((model) => providerMatches || matches(modelSearchText(provider, model), query))
      : provider.models;
    if (models.length === 0) continue;
    rows.push({ kind: "provider", key: `provider:${provider.name}`, label: provider.displayName });
    for (const model of models) {
      rows.push({ kind: "model", key: `model:${provider.name}:${model.id}`, provider, model });
    }
  }
  return rows;
}

function closestModelIndex(rows: Row[], currentModel?: string): number {
  const exact = rows.findIndex((row) => row.kind === "model" && row.model.id === currentModel);
  if (exact >= 0) return exact;
  return rows.findIndex((row) => row.kind === "model");
}

function nextModelIndex(rows: Row[], current: number, direction: 1 | -1): number {
  if (rows.length === 0) return -1;
  let index = current;
  for (let step = 0; step < rows.length; step += 1) {
    index = (index + direction + rows.length) % rows.length;
    if (rows[index]?.kind === "model") return index;
  }
  return -1;
}

export function ModelPickerDialog(props: {
  providers: ModelProviderInfo[];
  currentModel?: string;
  onSelect(model: ModelInfo): void;
}) {
  const { providers, currentModel, onSelect } = props;
  const { theme } = useTheme();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => buildRows(providers, query.trim()), [providers, query]);
  const [selectedIndex, setSelectedIndex] = useState(() => closestModelIndex(rows, currentModel));
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setSelectedIndex(closestModelIndex(rows, currentModel));
  }, [currentModel, rows]);

  useKeyboard((key) => {
    if (rows.length === 0) return;
    if (key.name === "up") {
      setSelectedIndex((index) => nextModelIndex(rows, index, -1));
      return;
    }
    if (key.name === "down") {
      setSelectedIndex((index) => nextModelIndex(rows, index, 1));
      return;
    }
    if (key.name === "return") {
      const row = rows[selectedIndex];
      if (row?.kind === "model") onSelect(row.model);
    }
  });

  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(AC_VISIBLE_ITEMS / 2),
      rows.length - AC_VISIBLE_ITEMS,
    ),
  );
  const visibleRows = rows.slice(windowStart, windowStart + AC_VISIBLE_ITEMS);

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text attributes={TextAttributes.BOLD} fg={theme.colors.accent}>Select model</text>
        <text fg={theme.colors.muted}>   esc</text>
      </box>

      <input
        focused
        placeholder="Search"
        onInput={(value: string) => setQuery(value)}
      />

      {visibleRows.length === 0 ? (
        <text fg={theme.colors.muted}>No connected providers.</text>
      ) : (
        <>
          {visibleRows.map((row) => {
            if (row.kind === "provider") {
              return (
                <text key={row.key} fg={theme.colors.accent}>
                  {row.label}
                </text>
              );
            }

            const isSelected = rows.indexOf(row) === selectedIndex;
            const isCurrent = row.model.id === currentModel;
            return (
              <box
                key={row.key}
                flexDirection="row"
                backgroundColor={isSelected ? theme.colors.accent : undefined}
              >
                <text
                  attributes={isCurrent ? TextAttributes.BOLD : undefined}
                  fg={isSelected ? theme.colors.background : theme.colors.foreground}
                >
                  {row.model.label}
                </text>
                <box flexGrow={1} />
                {row.model.hint ? (
                  <text fg={isSelected ? theme.colors.background : theme.colors.muted}>
                    {row.model.hint}
                  </text>
                ) : null}
              </box>
            );
          })}
        </>
      )}

      <box flexDirection="row">
        <text fg={theme.colors.foreground}>Connect provider </text>
        <text fg={theme.colors.muted}>ctrl+a  </text>
        <text fg={theme.colors.foreground}>Favorite </text>
        <text fg={theme.colors.muted}>ctrl+f</text>
      </box>
    </box>
  );
}
