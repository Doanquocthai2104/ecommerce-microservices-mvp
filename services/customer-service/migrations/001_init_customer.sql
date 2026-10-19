CREATE TABLE IF NOT EXISTS public."MemberShip" (
    mid INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mname VARCHAR(50) NOT NULL UNIQUE,
    score INT NOT NULL CHECK (score >= 0)
);

CREATE TABLE IF NOT EXISTS public."Customer" (
    uid INT PRIMARY KEY CHECK (uid > 0),
    fullname VARCHAR(100) NOT NULL,
    mid INT NOT NULL REFERENCES public."MemberShip"(mid)
);

INSERT INTO public."MemberShip" (mname, score)
VALUES ('BASIC', 0)
ON CONFLICT (mname) DO NOTHING;