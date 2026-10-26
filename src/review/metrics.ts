import type { TrainingRecord } from "../tools/read.ts";

export interface TrainingMetrics {
  load: number;
  volume: number;
  completion: number;
}

/** 负荷、容量、完成情况。固定算法，不进沙盒。 */
export function summarizeTraining(records: readonly TrainingRecord[]): TrainingMetrics {
  const load = records.reduce((sum, row) => sum + row.load, 0);
  const volume = records.reduce((sum, row) => sum + row.volume, 0);
  const completion = records.length === 0 ? 0 : records.filter((row) => row.completed).length / records.length;
  return { load, volume, completion };
}
