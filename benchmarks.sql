.timer ON
.echo ON

-- Sanity check queries

SELECT COUNT(*)
FROM stable_transactions;

SELECT COUNT(*)
FROM tags;

SELECT COUNT(*)
FROM stable_transaction_tags;

-- Owner queries

SELECT HEX(id)
FROM stable_transactions
WHERE owner_address = x'7F5229A2CD9F54F6F13D53BAE460728243325B4B64021A7685DA6B44F3C104DF'
ORDER BY height, block_transaction_index
LIMIT 100;

EXPLAIN SELECT HEX(id)
FROM stable_transactions
WHERE owner_address = x'7F5229A2CD9F54F6F13D53BAE460728243325B4B64021A7685DA6B44F3C104DF'
ORDER BY height DESC, block_transaction_index DESC
LIMIT 100;

-- Target queries

SELECT HEX(id)
FROM stable_transactions
WHERE target = x'EA9F35ED72BEC885FE841090D2A0F9C1B70FD3958F4203CA166C0D602DB1B703'
ORDER BY height, block_transaction_index
LIMIT 100;

SELECT HEX(id)
FROM stable_transactions
WHERE target = x'EA9F35ED72BEC885FE841090D2A0F9C1B70FD3958F4203CA166C0D602DB1B703'
ORDER BY height DESC, block_transaction_index DESC
LIMIT 100;

-- Tag queries

-- NOTE Sorting is based on values in the transaction tags table

SELECT HEX(st.id)
FROM stable_transactions st
JOIN stable_transaction_tags stt ON stt.height = st.height AND stt.block_transaction_index = st.block_transaction_index
WHERE stt.tag_hash = x'0ACA3398B829AA7A47D47C3BF1180D2A'
ORDER BY stt.height, stt.block_transaction_index
LIMIT 100;

SELECT HEX(st.id)
FROM stable_transactions st
JOIN stable_transaction_tags stt ON stt.height = st.height AND stt.block_transaction_index = st.block_transaction_index
WHERE stt.tag_hash = x'0ACA3398B829AA7A47D47C3BF1180D2A'
ORDER BY stt.height DESC, stt.block_transaction_index DESC
LIMIT 100;


SELECT HEX(st.id)
FROM stable_transactions st
JOIN stable_transaction_tags stt ON stt.height = st.height AND stt.block_transaction_index = st.block_transaction_index
WHERE stt.tag_hash = x'0ACA3398B829AA7A47D47C3BF1180D2A' AND stt.height < 830000
ORDER BY stt.height, stt.block_transaction_index
LIMIT 100;

SELECT HEX(st.id)
FROM stable_transactions st
JOIN stable_transaction_tags stt ON stt.height = st.height AND stt.block_transaction_index = st.block_transaction_index
WHERE stt.tag_hash = x'0ACA3398B829AA7A47D47C3BF1180D2A' AND stt.height <= 830000
ORDER BY stt.height, stt.block_transaction_index
LIMIT 100;
