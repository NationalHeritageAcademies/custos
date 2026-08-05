-- A second database so the "connect to the server, then pick a database"
-- flow and the live integration harness have more than one database to browse.
CREATE DATABASE IF NOT EXISTS warehouse CHARACTER SET utf8mb4;
USE warehouse;

CREATE TABLE shipments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  tracking VARCHAR(40) NOT NULL,
  carrier VARCHAR(20) NOT NULL
);

INSERT INTO shipments (tracking, carrier) VALUES
  ('1Z999AA', 'UPS'),
  ('EE123', 'USPS'),
  ('FX456', 'FedEx'),
  ('DH789', 'DHL');
