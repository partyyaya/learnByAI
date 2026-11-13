ALTER TABLE orders ADD INDEX idx_verify_total(total_amount), ALGORITHM=INPLACE, LOCK=NONE;
