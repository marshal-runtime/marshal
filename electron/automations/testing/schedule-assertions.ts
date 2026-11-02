import type {
  IntervalSchedule,
  MultiSchedule,
  SingleSchedule,
  StrictAutomationSchedule,
} from "../domain/contracts";

function unexpectedScheduleKind(
  expected: StrictAutomationSchedule["kind"],
  actual: StrictAutomationSchedule["kind"],
): Error {
  return new Error(`expected schedule kind "${expected}", got "${actual}"`);
}

export function asInterval(schedule: StrictAutomationSchedule): IntervalSchedule {
  if (schedule.kind !== "interval") {
    throw unexpectedScheduleKind("interval", schedule.kind);
  }
  return schedule;
}

export function asMulti(schedule: StrictAutomationSchedule): MultiSchedule {
  if (schedule.kind !== "multi") {
    throw unexpectedScheduleKind("multi", schedule.kind);
  }
  return schedule;
}

export function asSingle(schedule: StrictAutomationSchedule): SingleSchedule {
  if (schedule.kind !== "single") {
    throw unexpectedScheduleKind("single", schedule.kind);
  }
  return schedule;
}
