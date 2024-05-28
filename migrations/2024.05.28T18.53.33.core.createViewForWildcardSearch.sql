-- up migration
create view transactionsTagsDecoded as
select distinct *
from (select transaction_id,
             tag_name_hash,
             cast(tag_names.name as varchar)   as tag_name,
             tag_value_hash,
             cast(tag_values.value as varchar) as tag_value,
             transaction_tag_index,
             height
      from stable_transaction_tags
               join tag_names on tag_names.hash = tag_name_hash
               join tag_values on tag_values.hash = tag_value_hash
      union
      select transaction_id,
             tag_name_hash,
             cast(tag_names.name as varchar)   as tag_name,
             tag_value_hash,
             cast(tag_values.value as varchar) as tag_value,
             transaction_tag_index,
             height
      from new_transaction_tags
               left join tag_names on tag_names.hash = tag_name_hash
               left join tag_values on tag_values.hash = tag_value_hash);

create index tagNamesIndex on tag_names (hash, name);
create index tagValuesIndex on tag_values (hash, value);
