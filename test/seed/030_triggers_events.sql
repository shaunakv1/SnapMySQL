-- Trigger
DROP TRIGGER IF EXISTS users_bi;
DELIMITER //
CREATE TRIGGER users_bi BEFORE INSERT ON users
FOR EACH ROW
BEGIN
  IF NEW.created_at IS NULL THEN
    SET NEW.created_at = CURRENT_TIMESTAMP;
  END IF;
END //
DELIMITER ;

-- Event (requires event_scheduler=ON)
DROP EVENT IF EXISTS ev_touch;
DELIMITER //
CREATE EVENT ev_touch
  ON SCHEDULE EVERY 1 DAY
  DO
BEGIN
  -- simple no-op to test events existence
  SELECT 1;
END //
DELIMITER ;
