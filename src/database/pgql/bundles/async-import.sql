-- selectTransactionHeight
SELECT height
FROM new_transactions
WHERE id = @transaction_id AND height IS NOT NULL
UNION
SELECT height
FROM stable_transactions
WHERE id = @transaction_id
UNION
SELECT height
FROM missing_transactions
WHERE transaction_id = @transaction_id
LIMIT 1
    FOR UPDATE;
