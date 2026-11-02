import { ListFilter, RotateCcw } from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/marshal-ui/marshal-popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  createTimelineFilterState,
  getTimelineDateRangeError,
  isTimelineFilterActive,
  timelineFilterActiveCount,
  TIMELINE_FILTER_CATEGORIES,
  type TimelineFilterCategory,
  type TimelineFilterState,
  type TimelineSubagentIdentity,
} from "../state/timelineFilters";

const CATEGORY_LABELS: Record<TimelineFilterCategory, string> = {
  assistant: "Assistant",
  user: "You",
  subagent: "Agents & reviewers",
  goal: "Goals",
  runtime: "Runtime",
  system: "System",
};

interface TimelineFiltersProps {
  compact?: boolean;
  filter: TimelineFilterState;
  subagents: TimelineSubagentIdentity[];
  visibleCount: number;
  totalCount: number;
  onChange: (filter: TimelineFilterState) => void;
}

export function TimelineFilters({
  compact = false,
  filter,
  subagents,
  visibleCount,
  totalCount,
  onChange,
}: TimelineFiltersProps) {
  const active = isTimelineFilterActive(filter);
  const activeCount = timelineFilterActiveCount(filter);
  const dateRangeError = getTimelineDateRangeError(filter);
  const selectedSubagentMissing =
    filter.subagentId !== null && !subagents.some((subagent) => subagent.id === filter.subagentId);

  const setCategory = (category: TimelineFilterCategory, checked: boolean) => {
    const selected = new Set(filter.categories);
    if (checked) selected.add(category);
    else selected.delete(category);
    onChange({
      ...filter,
      categories: TIMELINE_FILTER_CATEGORIES.filter((item) => selected.has(item)),
    });
  };

  return (
    <div className="flex items-center justify-end gap-2" data-testid="timeline-filter-toolbar">
      {active && !compact && (
        <>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {visibleCount} of {totalCount}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Clear timeline filters"
                onClick={() => onChange(createTimelineFilterState())}
              >
                <RotateCcw />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Clear filters</TooltipContent>
          </Tooltip>
        </>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={active ? `Filter timeline, ${activeCount} active` : "Filter timeline"}
            data-testid="timeline-filter-trigger"
          >
            <ListFilter data-icon="inline-start" />
            {!compact && "Filter"}
            {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          collisionPadding={8}
          className="max-h-[calc(100vh-1rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto"
          data-testid="timeline-filter-popover"
        >
          <PopoverHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <PopoverTitle>Timeline filters</PopoverTitle>
                <PopoverDescription>Filters apply to all loaded history.</PopoverDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!active}
                onClick={() => onChange(createTimelineFilterState())}
              >
                <RotateCcw data-icon="inline-start" />
                Reset
              </Button>
            </div>
          </PopoverHeader>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Show</legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {TIMELINE_FILTER_CATEGORIES.map((category) => {
                const id = `timeline-filter-${category}`;
                return (
                  <div key={category} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={filter.categories.includes(category)}
                      onCheckedChange={(checked) => setCategory(category, checked === true)}
                    />
                    <Label htmlFor={id} className="font-normal">
                      {CATEGORY_LABELS[category]}
                    </Label>
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="timeline-subagent-filter">Named agent or reviewer</Label>
            <Select
              value={filter.subagentId ?? "all"}
              onValueChange={(value) => {
                const subagentId = value === "all" ? null : value;
                onChange({
                  ...filter,
                  subagentId,
                  categories:
                    subagentId && !filter.categories.includes("subagent")
                      ? TIMELINE_FILTER_CATEGORIES.filter(
                          (category) =>
                            category === "subagent" || filter.categories.includes(category),
                        )
                      : filter.categories,
                });
              }}
              disabled={subagents.length === 0 && filter.subagentId === null}
            >
              <SelectTrigger id="timeline-subagent-filter" className="w-full" size="sm">
                <SelectValue placeholder="All agents and reviewers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents and reviewers</SelectItem>
                {selectedSubagentMissing && filter.subagentId && (
                  <SelectItem value={filter.subagentId}>
                    Agent {filter.subagentId.slice(0, 8)}
                  </SelectItem>
                )}
                {subagents.map((subagent) => (
                  <SelectItem key={subagent.id} value={subagent.id}>
                    {subagent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted-foreground">
              Local date and time
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="timeline-filter-from">From</Label>
                <Input
                  id="timeline-filter-from"
                  type="datetime-local"
                  step={1}
                  value={filter.from}
                  aria-invalid={dateRangeError ? true : undefined}
                  onChange={(event) => onChange({ ...filter, from: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="timeline-filter-to">To</Label>
                <Input
                  id="timeline-filter-to"
                  type="datetime-local"
                  step={1}
                  value={filter.to}
                  aria-invalid={dateRangeError ? true : undefined}
                  onChange={(event) => onChange({ ...filter, to: event.target.value })}
                />
              </div>
            </div>
            {dateRangeError && (
              <p className="text-xs text-destructive" role="alert">
                {dateRangeError}
              </p>
            )}
          </fieldset>
        </PopoverContent>
      </Popover>
    </div>
  );
}
