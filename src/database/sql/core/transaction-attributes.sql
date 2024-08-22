-- selectTransactionAttributes
SELECT 
  signature 
FROM new_transactions
WHERE id = @id
UNION
SELECT 
  signature 
FROM stable_transactions
WHERE id = @id
LIMIT 1