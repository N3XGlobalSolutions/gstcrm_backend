-- Job-work Bill Cycle Required Touch % (owner, 2026-11-06, Issue & Job Works):
-- an employee's job-work cycle carries a Required Touch, like labour_bill_cycles
-- (0026). Optional on the cycle (old cycles have none); a job work with any Gold
-- or Ornament Receipt row needs it, from the bill form or stored here.
-- job_work_cycles already carries the gstcrm_audit row trigger (0025), which
-- records whole rows — the new column is audited automatically.
ALTER TABLE "job_work_cycles" ADD COLUMN IF NOT EXISTS "required_touch" numeric(6, 2);
