import type { DefectRecord } from '../../models/defect-record';
import { isDateOnly, type DateOnly } from '../../utils/date';
import { isCompletedStatus, isRejectedStatus } from '../status/status';
import { isTatOverdue } from '../tat/tat';
import type { RecordFilterKey } from '../filters/filters';

export interface AnalysisCategory {
  key: string;
  label: string;
  count: number;
  filters: Partial<Record<RecordFilterKey, string>>;
}

export interface AnalysisTrendPoint {
  month: string;
  count: number;
}

export interface AnalysisSummary {
  total: number;
  active: number;
  completed: number;
  rejected: number;
  overdue: number;
  plantCount: number;
  monthCount: number;
}

export interface AnalysisSnapshot {
  summary: AnalysisSummary;
  trend: AnalysisTrendPoint[];
  byPlant: AnalysisCategory[];
  byProjectModel: AnalysisCategory[];
  byReason: AnalysisCategory[];
  byDefectCode: AnalysisCategory[];
  byStatus: AnalysisCategory[];
}

const NOT_SPECIFIED = 'Not specified';
const NOT_ANALYZED = 'Not analyzed';

type GroupBuilder = {
  key: string;
  label: string;
  count: number;
  filters: Partial<Record<RecordFilterKey, string>>;
};

function sourceText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function topCategories(groups: Map<string, GroupBuilder>, limit: number): AnalysisCategory[] {
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, Math.max(0, limit))
    .map(({ key, label, count, filters }) => ({ key, label, count, filters }));
}

function groupByField(
  records: readonly DefectRecord[],
  readValue: (record: DefectRecord) => string,
  labelForMissing: string,
  filterKey: RecordFilterKey,
  limit: number,
): AnalysisCategory[] {
  const groups = new Map<string, GroupBuilder>();
  for (const record of records) {
    const value = readValue(record);
    const present = Boolean(value.trim());
    const key = present ? `value:${value}` : 'missing:';
    const filterValue = present ? value : '';
    const group = groups.get(key) ?? {
      key,
      label: present ? value : labelForMissing,
      count: 0,
      filters: { [filterKey]: filterValue } as Partial<Record<RecordFilterKey, string>>,
    };
    group.count += 1;
    groups.set(key, group);
  }
  return topCategories(groups, limit);
}

function aggregateProjectModel(records: readonly DefectRecord[], limit: number): AnalysisCategory[] {
  const groups = new Map<string, GroupBuilder>();
  for (const record of records) {
    const rawProject = sourceText(record.project);
    const rawModel = sourceText(record.model);
    const project = rawProject.trim() ? rawProject : '';
    const model = rawModel.trim() ? rawModel : '';
    const key = JSON.stringify([project, model]);
    const group = groups.get(key) ?? {
      key,
      label: [project || NOT_SPECIFIED, model || NOT_SPECIFIED].join(' · '),
      count: 0,
      filters: { project, model },
    };
    group.count += 1;
    groups.set(key, group);
  }
  return topCategories(groups, limit);
}

function aggregateTrend(records: readonly DefectRecord[]): AnalysisTrendPoint[] {
  const groups = new Map<string, number>();
  for (const record of records) {
    const registeredDate = record.registeredDate;
    if (!isDateOnly(registeredDate)) continue;
    const month = registeredDate.slice(0, 7);
    groups.set(month, (groups.get(month) ?? 0) + 1);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, count]) => ({ month, count }));
}

/**
 * All counts are computed from the supplied canonical repository records. Callers apply
 * the shared RecordFilters first so every section responds to the same filter context.
 */
export function calculateAnalysis(
  records: readonly DefectRecord[],
  today: DateOnly,
  topN = 6,
): AnalysisSnapshot {
  const completed = records.filter((record) => isCompletedStatus(record.status)).length;
  const trend = aggregateTrend(records);
  const plantGroups = new Set(records.map((record) => sourceText(record.plant).trim() ? sourceText(record.plant) : '__missing__'));

  return {
    summary: {
      total: records.length,
      active: records.length - completed,
      completed,
      rejected: records.filter((record) => isRejectedStatus(record.status)).length,
      overdue: records.filter((record) => isTatOverdue(record, today)).length,
      plantCount: plantGroups.size,
      monthCount: trend.length,
    },
    trend,
    byPlant: groupByField(records, (record) => sourceText(record.plant), NOT_ANALYZED, 'plant', topN),
    byProjectModel: aggregateProjectModel(records, topN),
    byReason: groupByField(records, (record) => sourceText(record.reason1), NOT_SPECIFIED, 'reason1', topN),
    byDefectCode: groupByField(records, (record) => sourceText(record.partCode), NOT_SPECIFIED, 'defectCode', topN),
    // Status is not a top-N taxonomy: retain every distinct source status in the distribution.
    byStatus: groupByField(records, (record) => record.status, NOT_SPECIFIED, 'status', Number.MAX_SAFE_INTEGER),
  };
}
