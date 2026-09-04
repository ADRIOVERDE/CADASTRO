-- Execute este script no Supabase > SQL Editor.
ALTER TABLE public.pessoas
ADD COLUMN IF NOT EXISTS nome_cadastrador text NOT NULL DEFAULT '';
