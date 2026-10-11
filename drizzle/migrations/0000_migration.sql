CREATE TABLE public.user_settings (
  user_id uuid PRIMARY KEY,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_settings TO authenticated;
GRANT ALL ON public.user_settings TO service_role;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own settings select" ON public.user_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own settings insert" ON public.user_settings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own settings update" ON public.user_settings FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own settings delete" ON public.user_settings FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.trades (
  id text NOT NULL,
  user_id uuid NOT NULL,
  time timestamptz NOT NULL,
  type text NOT NULL,
  pred int,
  symbol text NOT NULL,
  stake numeric NOT NULL,
  profit numeric NOT NULL,
  recovery boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trades TO authenticated;
GRANT ALL ON public.trades TO service_role;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own trades select" ON public.trades FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own trades insert" ON public.trades FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own trades delete" ON public.trades FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE INDEX trades_user_time_idx ON public.trades (user_id, time DESC);