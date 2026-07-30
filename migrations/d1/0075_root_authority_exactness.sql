-- Make Root authority and session revocation generations fail closed.
--
-- Existing 0073/0074 guards re-read the user row, but their historical
-- `role >= 100` predicates are broader than the source role enum. This
-- additive migration rejects invalid legacy rows before installing global
-- user guards, then adds exact-Root guards at both registration write
-- boundaries. It does not add a route or enable the registration ceremony.

CREATE TABLE root_authority_exactness_preflight (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1)
);

CREATE TRIGGER root_authority_exactness_preflight_guard
BEFORE INSERT ON root_authority_exactness_preflight
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM users
    WHERE typeof(role) <> 'integer'
       OR role NOT IN (0, 1, 10, 100)
       OR typeof(session_epoch) <> 'integer'
       OR session_epoch < 0
       OR session_epoch > 9007199254740991
  ) THEN RAISE(
    ABORT,
    '0075 requires valid user roles and session generations'
  ) END;
END;

INSERT INTO root_authority_exactness_preflight(singleton) VALUES (1);

DROP TRIGGER root_authority_exactness_preflight_guard;
DROP TABLE root_authority_exactness_preflight;

CREATE TRIGGER users_authority_insert_guard
BEFORE INSERT ON users
FOR EACH ROW
WHEN typeof(NEW.role) <> 'integer'
  OR NEW.role NOT IN (0, 1, 10, 100)
  OR typeof(NEW.session_epoch) <> 'integer'
  OR NEW.session_epoch < 0
  OR NEW.session_epoch > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'user authority fields are invalid');
END;

CREATE TRIGGER users_role_update_guard
BEFORE UPDATE OF role ON users
FOR EACH ROW
WHEN typeof(NEW.role) <> 'integer'
  OR NEW.role NOT IN (0, 1, 10, 100)
BEGIN
  SELECT RAISE(ABORT, 'user role is invalid');
END;

CREATE TRIGGER users_session_epoch_update_guard
BEFORE UPDATE OF session_epoch ON users
FOR EACH ROW
WHEN typeof(NEW.session_epoch) <> 'integer'
  OR NEW.session_epoch < OLD.session_epoch
  OR NEW.session_epoch < 0
  OR NEW.session_epoch > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'user session generation must be monotonic');
END;

CREATE TRIGGER relay_container_drain_source_command_exact_root_guard
BEFORE INSERT ON relay_container_drain_source_registration_commands
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM users AS root_user
  WHERE root_user.id = NEW.root_admin_id
    AND root_user.role = 100
    AND root_user.status = 1
    AND root_user.deleted_at IS NULL
    AND root_user.session_epoch = NEW.root_session_epoch
)
BEGIN
  SELECT RAISE(
    ABORT,
    'drain source registration command requires exact live Root authority'
  );
END;

CREATE TRIGGER relay_container_drain_source_registration_exact_root_guard
BEFORE INSERT ON relay_container_drain_source_authorization_registrations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM users AS root_user
  WHERE root_user.id = NEW.root_admin_id
    AND root_user.role = 100
    AND root_user.status = 1
    AND root_user.deleted_at IS NULL
    AND root_user.session_epoch = NEW.root_session_epoch
)
BEGIN
  SELECT RAISE(
    ABORT,
    'drain source registration requires exact live Root authority'
  );
END;
