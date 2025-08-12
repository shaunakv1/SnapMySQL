-- Stored function
DROP FUNCTION IF EXISTS add_one;
DELIMITER //
CREATE FUNCTION add_one(n INT) RETURNS INT DETERMINISTIC
BEGIN
  RETURN n + 1;
END //
DELIMITER ;

-- Stored procedure
DROP PROCEDURE IF EXISTS sp_upsert_user;
DELIMITER //
CREATE PROCEDURE sp_upsert_user(IN p_email VARCHAR(255), IN p_full_name VARCHAR(255))
BEGIN
  INSERT INTO users (email, full_name) VALUES (p_email, p_full_name)
  ON DUPLICATE KEY UPDATE full_name = VALUES(full_name);
END //
DELIMITER ;
