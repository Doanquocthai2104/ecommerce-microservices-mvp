CREATE TABLE IF NOT EXISTS public."Order" (
    oid INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    uid INT NOT NULL CHECK (uid > 0),

    request_id UUID NOT NULL,

    subtotal DECIMAL(10,2) NOT NULL
        CHECK (subtotal >= 0),

    discount DECIMAL(10,2) NOT NULL DEFAULT 0
        CHECK (discount >= 0),

    total_amount DECIMAL(10,2) NOT NULL
        CHECK (total_amount >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT order_request_unique
        UNIQUE (uid, request_id),

    CONSTRAINT order_discount_valid
        CHECK (discount <= subtotal),

    CONSTRAINT order_total_valid
        CHECK (total_amount = subtotal - discount)
);

CREATE TABLE IF NOT EXISTS public."OrderDetail" (
    oid INT NOT NULL
        REFERENCES public."Order"(oid)
        ON DELETE CASCADE,

    pid INT NOT NULL CHECK (pid > 0),

    qty INT NOT NULL CHECK (qty > 0),

    unit_price DECIMAL(10,2) NOT NULL
        CHECK (unit_price >= 0),

    PRIMARY KEY (oid, pid)
);

CREATE TABLE IF NOT EXISTS public."OutboxEvent" (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    event_id UUID NOT NULL UNIQUE,

    oid INT NOT NULL
        REFERENCES public."Order"(oid),

    event_type VARCHAR(100) NOT NULL,

    topic VARCHAR(100) NOT NULL,

    payload JSONB NOT NULL
        CHECK (jsonb_typeof(payload) = 'object'),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    published_at TIMESTAMPTZ,

    attempts INT NOT NULL DEFAULT 0
        CHECK (attempts >= 0),

    last_error TEXT,

    CONSTRAINT outbox_order_event_unique
        UNIQUE (oid, event_type)
);

CREATE INDEX IF NOT EXISTS order_customer_idx
ON public."Order" (uid, oid);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
ON public."OutboxEvent" (id)
WHERE published_at IS NULL;