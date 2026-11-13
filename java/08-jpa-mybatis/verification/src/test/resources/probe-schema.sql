CREATE TABLE money_probe(id bigint PRIMARY KEY,bare decimal(19,4),annotated decimal(19,4),required varchar(50));
CREATE TABLE seq_row(id bigint AUTO_INCREMENT PRIMARY KEY,code varchar(50),amount decimal(19,4));
CREATE TABLE uuid_row(id binary(16) PRIMARY KEY,code varchar(50),amount decimal(19,4));
