import logging
import re
from typing import Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from backend.models import Rule
from backend.schemas import RawAlert

logger = logging.getLogger(__name__)


def _evaluate_condition(condition: dict, alert: RawAlert) -> bool:
    field = condition.get("field", "")
    operator = condition.get("operator", "equals")
    value = condition.get("value", "")
    alert_data = alert.model_dump()
    field_value = alert_data.get(field) or alert.raw_payload.get(field, "")
    if field_value is None:
        field_value = ""
    field_str = str(field_value).lower()
    value_str = str(value).lower()
    match operator:
        case "equals": return field_str == value_str
        case "not_equals": return field_str != value_str
        case "contains": return value_str in field_str
        case "not_contains": return value_str not in field_str
        case "greater_than":
            try: return float(field_value) > float(value)
            except (ValueError, TypeError): return False
        case "less_than":
            try: return float(field_value) < float(value)
            except (ValueError, TypeError): return False
        case "matches_regex":
            try: return bool(re.search(value, str(field_value), re.IGNORECASE))
            except re.error: return False
        case _: return False


class RuleEngineResult:
    def __init__(self):
        self.suppressed: bool = False
        self.severity_override: Optional[str] = None
        self.notify_telegram: Optional[bool] = None
        self.notify_email: Optional[bool] = None
        self.cooldown_minutes: Optional[int] = None


async def evaluate(alert: RawAlert, db: AsyncSession) -> RuleEngineResult:
    result = RuleEngineResult()
    stmt = select(Rule).where(Rule.enabled == True).where((Rule.source_slug == None) | (Rule.source_slug == alert.source_slug))  # noqa
    rules = (await db.execute(stmt)).scalars().all()
    for rule in rules:
        try:
            condition = rule.condition
            if not condition or not _evaluate_condition(condition, alert):
                continue
            action = rule.action or "notify"
            if action == "suppress":
                result.suppressed = True
                return result
            if rule.severity_override:
                result.severity_override = rule.severity_override
            if rule.notify_telegram is not None:
                result.notify_telegram = rule.notify_telegram
            if rule.notify_email is not None:
                result.notify_email = rule.notify_email
            if rule.cooldown_minutes is not None:
                result.cooldown_minutes = rule.cooldown_minutes
        except Exception:
            logger.exception("Error evaluating rule id=%d", rule.id)
    return result
