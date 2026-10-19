INSERT INTO public."MemberShip" (mname, score)
VALUES
  ('BASIC', 0),
  ('SILVER', 100),
  ('GOLD', 500),
  ('PLATINUM', 1000)
ON CONFLICT (mname) DO NOTHING;