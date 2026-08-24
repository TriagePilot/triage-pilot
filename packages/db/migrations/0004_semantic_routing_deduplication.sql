alter table webhook_receipts
  add column event_action text,
  add column hook_id text;

alter table routing_decisions
  add column routing_key text;

update routing_decisions
  set routing_key = 'legacy:' || delivery_id
  where routing_key is null;

alter table routing_decisions
  alter column routing_key set not null;

create unique index routing_decisions_routing_key_idx on routing_decisions (routing_key);
