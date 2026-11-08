-- Test data and the accounts the harnesses sign in as; `customer` itself is created by the image from its *_USER variables.
CREATE TABLE customer_db.players (
	id int NOT NULL AUTO_INCREMENT,
	name varchar(64) NOT NULL,
	score int DEFAULT 0,
	PRIMARY KEY (id)
) ENGINE=InnoDB;
INSERT INTO customer_db.players (name, score) VALUES ('Ada', 42), ('Grace', 77), ('Linus', 13);

-- Database-level grant option only, which phpMyAdmin answers with "No Privileges".
CREATE USER 'pma_grant'@'%' IDENTIFIED BY 'grantpw';
GRANT ALL PRIVILEGES ON customer_db.* TO 'pma_grant'@'%' WITH GRANT OPTION;

CREATE USER 'pma_creator'@'%' IDENTIFIED BY 'creatorpw';
GRANT CREATE USER ON *.* TO 'pma_creator'@'%';
GRANT ALL PRIVILEGES ON customer_db.* TO 'pma_creator'@'%';
