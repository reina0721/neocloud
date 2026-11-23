CREATE TABLE iam_password_policy (
    id INTEGER PRIMARY KEY,
    overridden BOOLEAN NOT NULL,
    min_length INTEGER NOT NULL,
    max_length INTEGER NOT NULL,
    require_complexity BOOLEAN NOT NULL,
    version BIGINT NOT NULL
);

INSERT INTO iam_password_policy (id, overridden, min_length, max_length, require_complexity, version)
VALUES (1, FALSE, 0, 0, FALSE, 1);
