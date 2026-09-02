# agent/contracts

Pydantic models for every payload that crosses a process boundary, generated from
`contracts/openapi.yaml`.

**`models.py` is not written by hand.** Regenerate with `npm run contracts:generate`;
`npm run contracts:check` fails CI if it has drifted.

## Wire format

The contract is camelCase; these models are snake_case with aliases. That means
serialisation must go through the alias:

```python
envelope.model_dump_json(by_alias=True)          # correct
CommandEnvelope.model_validate_json(raw)         # correct, raw is camelCase
envelope.model_dump_json()                       # WRONG -- emits snake_case
```

Every model sets `extra="forbid"`, matching `additionalProperties: false` in the
spec. An unexpected field is a validation error, not a silently ignored key. That is
deliberate: the agent re-validates everything the cloud sends it.

## Environment

Python 3.12, per `CLAUDE.md`.

```
python3.12 -m venv agent/.venv
agent/.venv/bin/pip install -r agent/requirements-dev.txt
```
