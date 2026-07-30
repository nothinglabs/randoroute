#!/usr/bin/env python3
"""
Four sources can describe one road. Which count wins is a stated rule, not an
accident of evaluation order, so it gets a test of its own.

THE RULE (scripts/roadmeasure.py): the most recent count wins; where the years
tie, a measured count beats a modelled one.

Recency decides because neither source is systematically better. On the 27,279
graph edges where the county road log and HPMS both land, the median ratio
between them is exactly 1.00 -- scatter, not bias. With nothing separating them
on accuracy, the count taken closer to today describes the road today.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from roadmeasure import (  # noqa: E402
    ADT_SOURCE_COUNTY, ADT_SOURCE_HPMS, ADT_SOURCE_STATE, _better_count)

COUNTY, STATE, HPMS = ADT_SOURCE_COUNTY, ADT_SOURCE_STATE, ADT_SOURCE_HPMS
NAME = {COUNTY: 'county', STATE: 'state', HPMS: 'HPMS'}

failures = []


def wins(candidate, incumbent, expected, why):
    got = _better_count(candidate, incumbent)
    if got != expected:
        failures.append(
            f'{why}\n    candidate {candidate} vs incumbent {incumbent}: '
            f'expected {"replace" if expected else "keep"}, got '
            f'{"replace" if got else "keep"}')


# -------------------------------------------------------------- recency wins
wins((5000, 2022, COUNTY), (5200, 2018, HPMS), True,
     'a 2022 county count should displace a 2018 HPMS estimate')
wins((5200, 2018, HPMS), (5000, 2022, COUNTY), False,
     'a 2018 estimate must not displace a 2022 count')
wins((5200, 2018, HPMS), (5000, 2016, COUNTY), True,
     'HPMS 2018 should displace a county count from 2016 -- recency is the rule '
     'even when the newer figure is modelled, because neither source is '
     'systematically better')
wins((12000, 2025, STATE), (11000, 2018, HPMS), True,
     'a current WSDOT state count should displace anything older')

# --------------------------------------------- measured beats modelled on a tie
wins((5000, 2018, COUNTY), (5200, 2018, HPMS), True,
     'same year: a measured county count beats a modelled HPMS estimate')
wins((5200, 2018, HPMS), (5000, 2018, COUNTY), False,
     'same year: a modelled estimate must not displace a measured count')
wins((5000, 2020, STATE), (5100, 2020, COUNTY), False,
     'two measured counts from the same year: first one holds, no churn')

# --------------------------------------------------------- undated counts lose
wins((5000, None, COUNTY), (5200, 2018, HPMS), False,
     'a count with no year must not displace a dated one -- it cannot be shown '
     'with a year, so it must not push aside something that can')
wins((5200, 2018, HPMS), (5000, None, COUNTY), True,
     'a dated estimate should displace an undated count')
wins((5000, None, COUNTY), None, True,
     'an undated count is still better than no count at all')

# ------------------------------------------------------------- the empty case
wins((100, 2000, HPMS), None, True, 'anything beats nothing')

if failures:
    print(f'FAIL  {len(failures)} of the tiebreak rules are wrong:\n')
    for f in failures:
        print('  ' + f)
    raise SystemExit(1)

print('PASS  the count tiebreak: recency first, measured over modelled on a tie,')
print('      undated never displaces dated  (11 cases)')
