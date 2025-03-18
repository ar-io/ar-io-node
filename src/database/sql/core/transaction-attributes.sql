-- selectTransactionAttributes
SELECT
  nt.signature,
  w.public_modulus as owner
FROM new_transactions nt
LEFT JOIN wallets w ON nt.owner_address = w.address
WHERE nt.id = @id
UNION
SELECT
  st.signature,
  w.public_modulus as owner
FROM stable_transactions st
LEFT JOIN wallets w ON st.owner_address = w.address
WHERE st.id = @id
LIMIT 1
