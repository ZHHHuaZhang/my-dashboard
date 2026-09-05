ALTER TABLE public.sync_records ALTER COLUMN uid SET DEFAULT auth.uid()::text;
