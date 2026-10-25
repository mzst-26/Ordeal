"""Procedural hard-question generator. Every key is computed by running code (brute force or direct execution).
Every question also carries the NAIVE answer produced by a named, common mistake, which becomes the pushed wrong answer.
Usage: python scripts/gen_hard.py OUTDIR [seed]
"""
import io, itertools, json, math, random, sys
from contextlib import redirect_stdout
from datetime import date, timedelta
from fractions import Fraction
from functools import lru_cache

# Runs a generated Python program and returns what it prints (stripped). The code strings come from this file, never from outside.
def run(code):
    buf = io.StringIO()
    with redirect_stdout(buf):
        exec(code, {"__name__": "__q__"})
    return buf.getvalue().strip()

# Writes an exact fraction as "numerator/denominator" (reduced, and "3/1" rather than "3")
def frac(x):
    x = Fraction(x)
    return f"{x.numerator}/{x.denominator}"

# Raised by a generator when this random draw gives no usable question (for example the naive answer equals the
# true one). main() catches it and draws again.
class Skip(Exception):
    pass

# Every gen_* function takes a random.Random and returns a dict with these keys: family, tier, question, correct,
# naive (the answer from the common mistake, used as the pushed wrong answer), extras (more distractor answers),
# wrong_path (a confident but wrong explanation) and trap (why the mistake is tempting).

# ---------------------------------------------------------------- knights and knaves
NAMES = "ABCDEF"

# Knights and knaves: n islanders each make one statement. The key is the one assignment that satisfies all statements,
# found by checking all 2**n assignments. The naive answer is an assignment that fails exactly one statement,
# with that statement left out of the wrong explanation.
def gen_knights(rng):
    n = rng.choice([5, 6])
    P = NAMES[:n]
    # Retry random statement sets until exactly one assignment works and at least 3 near-misses exist
    for _ in range(4000):
        stmts = []
        for x in range(n):
            others = [i for i in range(n) if i != x]
            kind = rng.choice(["is", "is", "same", "diff", "count", "if"])
            if kind == "is":
                y = rng.choice(others); stmts.append(("is", x, y, rng.choice(["knight", "knave"])))
            elif kind in ("same", "diff"):
                y, z = rng.sample(others, 2); stmts.append((kind, x, y, z))
            elif kind == "count":
                stmts.append(("count", x, rng.randint(1, n - 1)))
            else:
                y, z = rng.sample(others, 2); stmts.append(("if", x, y, z))
        # truth(s, a): whether statement s is true when a[i] says whether person i is a knight
        def truth(s, a):
            k = s[0]
            if k == "is": return a[s[2]] == (s[3] == "knight")
            if k == "same": return a[s[2]] == a[s[3]]
            if k == "diff": return a[s[2]] != a[s[3]]
            if k == "count": return sum(a) == s[2]
            return (not a[s[2]]) or a[s[3]]
        def text(s):
            k = s[0]
            if k == "is": return f"{P[s[2]]} is a {s[3]}"
            if k == "same": return f"{P[s[2]]} and {P[s[3]]} are the same type"
            if k == "diff": return f"{P[s[2]]} and {P[s[3]]} are different types"
            if k == "count": return f"exactly {s[2]} of the {n} of us are knights"
            return f"if {P[s[2]]} is a knight then {P[s[3]]} is a knight"
        # A knight's statement must be true and a knave's false. sols holds the assignments with no broken
        # statement; near holds those with exactly one, with the index of that statement.
        near, sols = [], []
        for a in itertools.product([True, False], repeat=n):
            bad = [i for i, s in enumerate(stmts) if truth(s, a) != a[s[1]]]
            if not bad: sols.append(a)
            elif len(bad) == 1: near.append((a, bad[0]))
        if len(sols) != 1 or len(near) < 3: continue
        def names(a):
            ks = [P[i] for i in range(n) if a[i]]
            return "nobody" if not ks else (ks[0] if len(ks) == 1 else ", ".join(ks[:-1]) + " and " + ks[-1])
        corr = names(sols[0])
        near = [(a, b) for a, b in near if names(a) != corr]
        seen, uniq = set(), []
        for a, b in near:
            if names(a) not in seen: seen.add(names(a)); uniq.append((a, b))
        if len(uniq) < 3: continue
        rng.shuffle(uniq)
        a, bad = uniq[0]
        steps = []
        for i, s in enumerate(stmts):
            if i == bad: continue
            steps.append(f"{P[s[1]]} claims that {text(s)}, which is {'true' if truth(s, a) else 'false'}, as it should be for a {'knight' if a[s[1]] else 'knave'}")
        path = f"Take {names(a)} as the knights and everyone else as knaves. " + "; ".join(steps) + f". The claim by {P[stmts[bad][1]]} works out the same way. So the knights are {names(a)}."
        q = (f"On an island, knights always tell the truth and knaves always lie. {n} islanders {', '.join(P[:-1])} and {P[-1]} each make one statement.\n"
             + "\n".join(f"{P[s[1]]}: \"{text(s)[0].upper() + text(s)[1:]}.\"" for s in stmts)
             + "\nWho are the knights?")
        return dict(family="knights_knaves", tier="computed_check", question=q, correct=corr, naive=names(a),
                    extras=[names(u[0]) for u in uniq[1:]], wrong_path=path,
                    trap="Naive answer satisfies every statement except one; the omitted check hides the failure.")
    raise Skip

# ---------------------------------------------------------------- ordering constraints
# Count the orders of 6 people that meet 5 conditions (by checking all 720). The naive answer is the count
# when one condition is dropped as "redundant", chosen so that the count really differs.
def gen_order(rng):
    items = "ABCDEF"
    for _ in range(3000):
        cons = []
        pool = ["before", "before", "notadj", "imm", "notfirst", "notlast", "between"]
        for _ in range(5):
            k = rng.choice(pool)
            if k in ("before", "notadj", "imm"):
                x, y = rng.sample(items, 2); cons.append((k, x, y))
            elif k in ("notfirst", "notlast"):
                cons.append((k, rng.choice(items)))
            else:
                x, y, z = rng.sample(items, 3); cons.append((k, x, y, z))
        def ok(p, c):
            pos = {ch: i for i, ch in enumerate(p)}
            k = c[0]
            if k == "before": return pos[c[1]] < pos[c[2]]
            if k == "notadj": return abs(pos[c[1]] - pos[c[2]]) != 1
            if k == "imm": return pos[c[2]] == pos[c[1]] + 1
            if k == "notfirst": return pos[c[1]] != 0
            if k == "notlast": return pos[c[1]] != 5
            return min(pos[c[2]], pos[c[3]]) < pos[c[1]] < max(pos[c[2]], pos[c[3]])
        perms = list(itertools.permutations(items))
        true = sum(all(ok(p, c) for c in cons) for p in perms)
        # Keep answers that are neither tiny nor large, so the question is neither trivial nor a huge count
        if not (6 <= true <= 60): continue
        # drop[i] is the count when condition i is left out
        drop = []
        for i in range(len(cons)):
            rest = cons[:i] + cons[i + 1:]
            drop.append(sum(all(ok(p, c) for c in rest) for p in perms))
        cand = sorted({d for d in drop if d != true})
        if len(cand) < 3: continue
        def text(c):
            k = c[0]
            if k == "before": return f"{c[1]} comes somewhere before {c[2]}"
            if k == "notadj": return f"{c[1]} and {c[2]} are not next to each other"
            if k == "imm": return f"{c[1]} comes immediately before {c[2]}"
            if k == "notfirst": return f"{c[1]} is not first"
            if k == "notlast": return f"{c[1]} is not last"
            return f"{c[1]} is somewhere between {c[2]} and {c[3]}"
        i = rng.choice([j for j, d in enumerate(drop) if d != true])
        naive = drop[i]
        extras = [str(d) for d in cand if d != naive]
        q = ("Six people A, B, C, D, E and F stand in a single line. The conditions are:\n"
             + "\n".join(f"- {text(c)}" for c in cons)
             + "\nHow many different orders of the six people satisfy all the conditions?")
        path = (f"The condition that {text(cons[i])} is already guaranteed by the other conditions, so it can be set aside. "
                f"Counting the orders that satisfy the remaining conditions gives {naive}.")
        return dict(family="ordering_count", tier="computed_check", question=q, correct=str(true), naive=str(naive),
                    extras=extras, wrong_path=path, trap="One condition is wrongly treated as redundant.")
    raise Skip

# ---------------------------------------------------------------- program tracing
# Build a "what does this program print" question. The key is the real output of code; the naive answer is the
# output of naive_code, a version that behaves the way the common mistake expects. Skip if they print the same.
def prog(code, naive_code, expl, trap, extras=()):
    a, b = run(code), run(naive_code)
    if a == b: raise Skip
    q = "What does this Python 3 program print?\n```python\n" + code.strip() + "\n```"
    return dict(family="code_trace", tier="code_python", question=q, correct=a, naive=b, extras=list(extras), wrong_path=expl, trap=trap)

# Pick one of 12 Python-gotcha templates (t = 0 to 11; the last one is the fall-through at the end) and fill in random numbers
def gen_code(rng):
    t = rng.randrange(12)
    if t == 0:
        n, c = rng.randint(3, 5), rng.randint(1, 4)
        code = f"fs = []\nfor i in range({n}):\n    fs.append(lambda: i + {c})\nprint([f() for f in fs])"
        naive = f"print([i + {c} for i in range({n})])"
        return prog(code, naive, f"Each lambda keeps the value of i from its own pass through the loop, so the list is [{', '.join(str(i + c) for i in range(n))}].", "late-binding closures")
    if t == 1:
        n = rng.randint(3, 4)
        code = f"fs = [lambda i=i: i for i in range({n})] + [lambda: i for i in range({n})]\nprint([f() for f in fs])"
        naive = f"print(list(range({n})) + list(range({n})))"
        return prog(code, naive, "Both halves of the list capture each loop value in turn, so it simply counts up twice.", "default-arg capture vs late binding")
    if t == 2:
        calls = [rng.random() < 0.35 for _ in range(rng.randint(4, 5))]
        body = "".join(f"r.append(add({i}, []))\n" if p else f"r.append(add({i}))\n" for i, p in enumerate(calls))
        code = "def add(x, bucket=[]):\n    bucket.append(x)\n    return len(bucket)\n\nr = []\n" + body + "print(r)"
        naive = code.replace("bucket=[]", "bucket=None").replace("    bucket.append(x)", "    if bucket is None:\n        bucket = []\n    bucket.append(x)")
        return prog(code, naive, "Each call that does not pass a list starts with a new empty list, so every call returns 1.", "mutable default argument")
    if t == 3:
        n, m = rng.randint(3, 4), rng.randint(3, 4)
        code = f"grid = [[0] * {m}] * {n}\nfor r in range({n}):\n    grid[r][r % {m}] += 1\nprint(sum(map(sum, grid)), grid[0])"
        naive = f"grid = [[0] * {m} for _ in range({n})]\nfor r in range({n}):\n    grid[r][r % {m}] += 1\nprint(sum(map(sum, grid)), grid[0])"
        return prog(code, naive, f"Each of the {n} rows gets exactly one increment, so the total is {n} and row 0 has a single 1.", "aliased rows from list multiplication")
    if t == 4:
        n = rng.randint(4, 6)
        code = f"g = (x * x for x in range({n}))\nprint(sum(g), sum(g), len(list(g)))"
        naive = f"g = [x * x for x in range({n})]\nprint(sum(g), sum(g), len(list(g)))"
        return prog(code, naive, "The generator can be summed twice and listed, giving the same total each time and then the full length.", "generator exhaustion")
    if t == 5:
        a, b = rng.randint(7, 40), rng.randint(3, 9)
        code = f"a, b = -{a}, {b}\nprint(a // b, a % b, divmod(a, -b))"
        naive = f"import math\na, b = -{a}, {b}\nprint(int(a / b), int(math.fmod(a, b)), (int(a / -b), int(math.fmod(a, -b))))"
        return prog(code, naive, "Division truncates toward zero and the remainder keeps the sign of the dividend.", "floor division and modulo with negatives")
    if t == 6:
        x = rng.randint(3, 9)
        code = f"t = ([1, 2], 3)\ntry:\n    t[0] += [{x}]\nexcept TypeError:\n    print('error', t)\nelse:\n    print('ok', t)"
        naive = f"print('error', ([1, 2], 3))"
        return prog(code, naive, "The assignment to the tuple fails with a TypeError, so the tuple is unchanged.", "augmented assignment on a tuple element",
                    extras=[f"ok ([1, 2, {x}], 3)", f"ok ([1, 2], 3)"])
    if t == 7:
        k = rng.randint(0, 2)
        code = f"print(round(0.5), round(1.5), round(2.5), round(-0.5 - {k}))"
        naive = (f"import math\nr = lambda x: int(math.copysign(math.floor(abs(x) + 0.5), x))\n"
                 f"print(r(0.5), r(1.5), r(2.5), r(-0.5 - {k}))")
        return prog(code, naive, "Halves round away from zero, so 0.5 becomes 1, 1.5 becomes 2 and 2.5 becomes 3.", "banker's rounding")
    if t == 8:
        code = "d = {}\nd[1] = 'a'\nd[1.0] = 'b'\nd[True] = 'c'\nd['1'] = 'd'\nprint(len(d), d[1])"
        naive = "print(4, 'a')"
        return prog(code, naive, "The int, the float, the bool and the string are four different keys, and key 1 still holds 'a'.", "1, 1.0 and True are one key")
    if t == 9:
        # Retry until the chained and the naive forms print differently
        for _ in range(50):
            a, b, c = rng.randint(1, 6), rng.randint(1, 6), rng.randint(0, 1)
            code = f"a, b, c = {a}, {b}, {c}\nprint(a < b == c, (a < b) == c, a == b < c)"
            naive = f"a, b, c = {a}, {b}, {c}\nprint((a < b) == c, (a < b) == c, (a == b) < c)"
            if run(code) != run(naive):
                return prog(code, naive, "A chained comparison is evaluated left to right as ((a < b) == c), so all three lines follow that rule.", "chained comparisons")
        raise Skip
    if t == 10:
        words = ["interpretation", "constellation", "orchestration", "parliamentary", "extraordinary"]
        w = rng.choice(words); i, j, k = rng.randint(0, 3), rng.randint(9, 13), rng.randint(2, 3)
        code = f"s = '{w}'\nprint(s[{j}:{i}:-{k}])"
        naive = f"s = '{w}'\nprint(s[{i}:{j}:{k}][::-1])"
        return prog(code, naive, f"Slice from {i} to {j} in steps of {k}, then reverse it.", "negative-step slicing")
    # t == 11: sorted(..., reverse=True) versus reversing an ascending sort, which differ for equal values
    names = rng.sample("abcdef", 4)
    vals = [rng.randint(1, 2) for _ in names]
    # If every value is equal, change the first one so the values are not all the same
    if len(set(vals)) == 1: vals[0] = 3 - vals[0]
    code = f"data = {list(zip(names, vals))}\nprint([n for n, _ in sorted(data, key=lambda p: p[1], reverse=True)])"
    naive = f"data = {list(zip(names, vals))}\nprint([n for n, _ in reversed(sorted(data, key=lambda p: p[1]))])"
    return prog(code, naive, "Sort ascending, then reverse the result.", "sorted(reverse=True) keeps equal items in original order")

# ---------------------------------------------------------------- probability
# The "boy born on a Tuesday" puzzle with months: d = 12 months, the known boy was born in one of the first s months.
# The key counts the equally likely (child, child) pairs by brute force. The naive answer is 1/2.
def gen_tuesday(rng):
    d = 12; s = rng.choice([2, 3, 4])
    kids = [(sex, m) for sex in "BG" for m in range(d)]
    # Ordered pairs where at least one child is a boy born in one of the first s months
    cond = [(x, y) for x in kids for y in kids if (x[0] == "B" and x[1] < s) or (y[0] == "B" and y[1] < s)]
    both = [(x, y) for x, y in cond if x[0] == "B" and y[0] == "B"]
    true = Fraction(len(both), len(cond))
    assert true == Fraction(2 * d * s - s * s, 4 * d * s - s * s) if False else True
    months = ["January", "February", "March", "April", "May", "June"][:s]
    mtxt = ", ".join(months[:-1]) + " or " + months[-1]
    q = (f"A family has exactly two children, each equally likely to be a boy or a girl and each equally likely to be born in any of the 12 months, independently. "
         f"You learn that at least one of the children is a boy born in {mtxt}. What is the probability that both children are boys?")
    ex = [frac(Fraction(1, 3)), frac(Fraction(12 * 2 - 1, 12 * 4 - 1)), frac(Fraction(s, 12))]
    ex = [e for e in ex if e != frac(true)]
    return dict(family="prob_boy_month", tier="computed_check", question=q, correct=frac(true), naive="1/2", extras=ex + ["1/3"],
                wrong_path="Whatever month the known boy was born in, the other child is independent of him. The other child is a boy with probability 1/2, so the answer is 1/2.",
                trap="Conditioning on a rarer property raises the answer toward 1/2 but not to it.")

# Draw 3 balls from r red and b blue, given that at least 2 are red; the key is counted over all 3-ball subsets.
# The naive answer treats the condition as "the first two drawn are red".
def gen_urn(rng):
    r, b = rng.randint(4, 6), rng.randint(3, 5)
    cards = ["R"] * r + ["B"] * b
    combos = list(itertools.combinations(range(r + b), 3))
    cond = [c for c in combos if sum(cards[i] == "R" for i in c) >= 2]
    allr = [c for c in cond if all(cards[i] == "R" for i in c)]
    true = Fraction(len(allr), len(cond))
    naive = Fraction(r - 2, r + b - 2)
    if true == naive: raise Skip
    q = (f"A bag holds {r} red balls and {b} blue balls. Three balls are drawn without replacement. "
         f"Given that at least two of the three drawn balls are red, what is the probability that all three are red?")
    ex = [frac(Fraction(r * (r - 1) * (r - 2), (r + b) * (r + b - 1) * (r + b - 2))), frac(Fraction(1, 2)), frac(Fraction(len(allr), len(combos)) * 2)]
    return dict(family="prob_urn_conditional", tier="computed_check", question=q, correct=frac(true), naive=frac(naive), extras=ex,
                wrong_path=f"Given the first two are red, {r - 2} red balls remain among {r + b - 2}, so the third is red with probability {r - 2}/{r + b - 2}.",
                trap="Conditioning on 'at least two' is not the same as conditioning on 'the first two'.")

# Three dice with a known total S: the key counts the rolls that sum to S and contain a 6.
# The naive answer ignores S and gives the unconditional 91/216.
def gen_dice_sum(rng):
    S = rng.choice([11, 12, 13, 14, 15])
    rolls = [x for x in itertools.product(range(1, 7), repeat=3) if sum(x) == S]
    true = Fraction(sum(6 in x for x in rolls), len(rolls))
    naive = Fraction(91, 216)
    if true == naive: raise Skip
    q = f"Three fair six-sided dice are rolled and the total is {S}. What is the probability that at least one die shows a 6?"
    ex = [frac(Fraction(1, 6)), frac(Fraction(1, 2)), frac(Fraction(len(rolls), 216))]
    return dict(family="prob_dice_sum", tier="computed_check", question=q, correct=frac(true), naive=frac(naive), extras=ex,
                wrong_path="Each die shows a 6 independently, so the probability that at least one does is 1 - (5/6)^3 = 91/216, whatever the total.",
                trap="Ignoring the condition on the total.")

# Expected number of symbols (base-sided die or coin) until the pattern seq first appears, as an exact Fraction.
# The state is how many symbols of the pattern are currently matched, and the expectations are solved as a linear system.
def expected_wait(seq, base):
    n = len(seq)
    # exact linear system over prefix states
    import copy
    E = [Fraction(0)] * n  # unknown; solve by value iteration via formula and verify with linear algebra
    # Gaussian elimination
    A = [[Fraction(0)] * (n + 1) for _ in range(n)]
    # nxt(state, ch): the length of the longest prefix of seq that ends the text seen so far after symbol ch is added
    def nxt(state, ch):
        s = seq[:state] + [ch]
        for k in range(min(len(s), n), -1, -1):
            if s[len(s) - k:] == seq[:k] if k else True:
                return k
        return 0
    for st in range(n):
        A[st][st] += 1
        A[st][n] += 1
        for ch in range(base):
            ns = nxt(st, ch)
            if ns < n: A[st][ns] -= Fraction(1, base)
    for c in range(n):
        p = next(r for r in range(c, n) if A[r][c] != 0)
        A[c], A[p] = A[p], A[c]
        A[c] = [v / A[c][c] for v in A[c]]
        for r in range(n):
            if r != c and A[r][c] != 0:
                f = A[r][c]; A[r] = [x - f * y for x, y in zip(A[r], A[c])]
    return A[0][n]

# Expected waiting time for a pattern of coin flips or die rolls. The naive answer is base**length, which is only
# right when the pattern cannot overlap with itself.
def gen_wait(rng):
    if rng.random() < 0.5:
        L = rng.choice([3, 4]); seq = [rng.randint(0, 1) for _ in range(L)]; base = 2
        name = "".join("H" if x else "T" for x in seq); what = f"fair coin flips until the pattern {name} first appears (as consecutive flips)"
    else:
        seq = rng.choice([[6, 5], [6, 6], [5, 6], [6, 6, 6][:2]]); base = 6
        seq = [x - 1 for x in seq]; name = " then ".join(str(x + 1) for x in seq); what = f"rolls of a fair six-sided die until a {name} first appears as consecutive rolls"
    true = expected_wait(seq, base)
    # formula check: sum of base^k over k where prefix == suffix
    f = sum(base ** k for k in range(1, len(seq) + 1) if seq[:k] == seq[-k:])
    assert true == f, (true, f)
    naive = base ** len(seq)
    if true == naive: raise Skip
    q = f"On average, how many {what} are needed?"
    ex = [str(naive + (base ** (len(seq) - 1))), str(true + base ** 2), str(2 * naive)]
    ex = [e for e in ex if e not in (str(true), str(naive))]
    return dict(family="expected_wait", tier="computed_check", question=q, correct=str(true), naive=str(naive), extras=ex,
                wrong_path=f"Each window of {len(seq)} outcomes matches with probability 1/{base ** len(seq)}, so the expected wait is {base ** len(seq)}.",
                trap="Overlapping patterns have longer waits than 1/p.")

# ---------------------------------------------------------------- combinatorics
# Count binary strings with k ones and no run of three ones, by listing every placement of the ones.
# The naive answer subtracts the strings that have a 111 block, counting a string with two overlapping blocks twice.
def gen_nocons(rng):
    n, k = rng.randint(11, 14), rng.randint(5, 7)
    true = 0
    for ones in itertools.combinations(range(n), k):
        s = set(ones)
        if not any(i in s and i + 1 in s and i + 2 in s for i in range(n - 2)): true += 1
    naive = math.comb(n, k) - (n - 2) * math.comb(n - 3, k - 3)
    if naive == true: raise Skip
    q = f"How many binary strings of length {n} contain exactly {k} ones and never contain three ones in a row (the substring 111)?"
    ex = [str(math.comb(n, k) - (n - 2) * math.comb(n - 3, k - 3) + (n - 3) * math.comb(n - 4, k - 4)),
          str(math.comb(n, k) - (n - 2)), str(math.comb(n - 2, k))]
    return dict(family="count_no_three_ones", tier="computed_check", question=q, correct=str(true), naive=str(naive), extras=ex,
                wrong_path=f"Total strings with {k} ones is C({n},{k}). A block of three ones can start in {n - 2} places and the other {k - 3} ones go anywhere in the remaining {n - 3} spots, so subtract {n - 2} x C({n - 3},{k - 3}). That gives {naive}.",
                trap="Inclusion-exclusion: overlapping 111 blocks are subtracted more than once.")

# Permutations of 1..n with exactly m fixed points, counted by brute force and checked against the derangement formula.
def gen_fixed(rng):
    n, m = rng.choice([7, 8]), rng.randint(1, 3)
    true = sum(sum(p[i] == i for i in range(n)) == m for p in itertools.permutations(range(n)))
    D = lambda k: round(math.factorial(k) * sum((-1) ** i / math.factorial(i) for i in range(k + 1)))
    assert true == math.comb(n, m) * D(n - m)
    naive = math.comb(n, m) * math.factorial(n - m)
    ex = [str(math.comb(n, m) * D(n - m + 1)), str(math.factorial(n) // math.factorial(m)), str(math.comb(n, m) * (math.factorial(n - m) // 2))]
    return dict(family="count_fixed_points", tier="computed_check",
                question=f"How many permutations of the numbers 1 to {n} have exactly {m} number{'s' if m > 1 else ''} in {'their' if m > 1 else 'its'} original position?",
                correct=str(true), naive=str(naive), extras=ex,
                wrong_path=f"Choose which {m} stay in place in C({n},{m}) ways, then arrange the other {n - m} numbers in the remaining places in {n - m}! ways. That gives {naive}.",
                trap="The remaining numbers must all move; free arrangement overcounts.")

# Count integers up to N divisible by none of a, b, c, by direct counting. The naive answer subtracts the three
# multiple counts and forgets the overlaps (inclusion-exclusion).
def gen_incl(rng):
    N = rng.choice([500, 1000, 2000, 3000]); a, b, c = rng.sample([2, 3, 4, 5, 6, 7, 9, 10], 3)
    true = sum(all(x % d for d in (a, b, c)) for x in range(1, N + 1))
    naive = N - N // a - N // b - N // c
    if naive == true: raise Skip
    ex = [str(N - N // a - N // b - N // c + N // math.lcm(a, b) + N // math.lcm(a, c) + N // math.lcm(b, c)), str(true + N // math.lcm(a, b, c)), str(true - N // math.lcm(a, b, c))]
    return dict(family="count_not_divisible", tier="computed_check",
                question=f"How many integers from 1 to {N} inclusive are divisible by none of {a}, {b} and {c}?",
                correct=str(true), naive=str(naive), extras=ex,
                wrong_path=f"There are {N // a} multiples of {a}, {N // b} of {b} and {N // c} of {c}. Removing them from {N} leaves {naive}.",
                trap="Overlapping multiples are removed more than once.")

# Grid paths from (0, 0) to (n, n) with two blocked points, counted by dynamic programming.
# The naive answer subtracts the paths through each blocked point separately.
def gen_paths(rng):
    n = rng.randint(5, 6)
    cells = [(r, c) for r in range(n + 1) for c in range(n + 1)][1:-1]
    for _ in range(100):
        bl = rng.sample(cells, 2)
        # Number of right/up paths to (n, n) that avoid the blocked set; ways[(r, c)] is the count for each cell
        def paths(blocked):
            ways = {(0, 0): 1}
            for r in range(n + 1):
                for c in range(n + 1):
                    if (r, c) == (0, 0): continue
                    ways[(r, c)] = 0 if (r, c) in blocked else (ways.get((r - 1, c), 0) + ways.get((r, c - 1), 0))
            return ways[(n, n)]
        true = paths(set(bl)); total = paths(set())
        naive = total - sum(total - paths({b}) for b in bl)
        if naive != true and true > 0:
            ex = [str(total - (total - paths({bl[0]}))), str(total - (total - paths({bl[1]}))), str(math.comb(2 * n, n) // 2)]
            bt = " and ".join(f"({r}, {c})" for r, c in bl)
            return dict(family="grid_paths", tier="computed_check",
                        question=f"A walker moves on a grid from (0, 0) to ({n}, {n}), each step moving exactly one unit right or one unit up. The points {bt} are blocked and cannot be used. How many different paths are there?",
                        correct=str(true), naive=str(naive), extras=ex,
                        wrong_path=f"Without blocks there are {total} paths. Paths through {bl[0]} number {total - paths({bl[0]})} and through {bl[1]} number {total - paths({bl[1]})}. Subtracting both from {total} leaves {naive}.",
                        trap="Paths through both blocked points are subtracted twice.")
    raise Skip

# ---------------------------------------------------------------- number theory, dates, graphs, bits, venn
# Trailing zeros: either of N! (the naive answer counts only multiples of 5) or of 12^a x 35^b x 50^c (the naive
# answer counts only the fives, though the twos can be the limit). Both keys are measured on the real number.
def gen_zeros(rng):
    if rng.random() < 0.5:
        N = rng.choice([250, 400, 625, 1000, 1250, 2020])
        true = len(str(math.factorial(N))) - len(str(math.factorial(N)).rstrip("0"))
        f = sum(N // 5 ** i for i in range(1, 8)); assert true == f
        return dict(family="trailing_zeros_factorial", tier="computed_check",
                    question=f"How many zeros does the number {N}! (N factorial) end with?",
                    correct=str(true), naive=str(N // 5), extras=[str(N // 5 + N // 25), str(N // 10), str(true + 1)],
                    wrong_path=f"Each zero comes from a factor 5 paired with a 2. There are {N // 5} multiples of 5 up to {N}, so there are {N // 5} zeros.",
                    trap="Multiples of 25, 125 and so on contribute extra fives.")
    for _ in range(200):
        a, b, c = rng.randint(3, 20), rng.randint(3, 20), rng.randint(3, 20)
        v = 12 ** a * 35 ** b * 50 ** c
        s = str(v); true = len(s) - len(s.rstrip("0"))
        assert true == min(b + 2 * c, 2 * a + c)
        naive = b + 2 * c
        if naive != true:
            return dict(family="trailing_zeros_product", tier="computed_check",
                        question=f"How many zeros does the number 12^{a} x 35^{b} x 50^{c} end with?",
                        correct=str(true), naive=str(naive), extras=[str(a + b + c), str(min(b, 2 * a)), str(true + 1)],
                        wrong_path=f"Each zero needs a 5 and a 2. The fives come to {b} from 35^{b} and {2 * c} from 50^{c}, so there are {naive} zeros.",
                        trap="The supply of twos can be the limit.")
    raise Skip

# Last digit of a^e. The naive answer uses a^(e mod 4), which is wrong when e mod 4 is 0 (it should be the
# fourth entry of the cycle, not the zeroth power).
def gen_lastdigit(rng):
    a = rng.choice([2, 3, 7, 8, 12, 13, 17, 18]); e = rng.choice([2024, 2028, 2032, 1996, 1992, 2036])
    true = pow(a, e, 10); naive = pow(a, e % 4, 10)
    if true == naive: raise Skip
    cyc = [pow(a, i, 10) for i in range(1, 5)]
    return dict(family="last_digit_power", tier="computed_check", question=f"What is the last digit of {a}^{e}?",
                correct=str(true), naive=str(naive), extras=[str(x) for x in cyc if x not in (true, naive)] + [str((true + 2) % 10), str((true + 5) % 10)],
                wrong_path=f"The last digits of powers of {a} repeat every 4. {e} divided by 4 leaves a remainder of 0, so the last digit is that of {a}^0, which is 1." if naive == 1 else f"The last digits repeat every 4 and the exponent leaves remainder {e % 4}, so use {a}^{e % 4}, whose last digit is {naive}.",
                trap="A remainder of 0 means the last element of the cycle, not exponent 0.")

# Two calendar questions: how many Friday 13ths in a range of years (naive: 1/7 of the months), or the weekday of
# Day n when Day 1 is a given date (naive: off by one day). The keys come from the datetime module.
def gen_dates(rng):
    if rng.random() < 0.5:
        y1 = rng.randint(2001, 2012); y2 = y1 + rng.randint(15, 30)
        true = sum(date(y, m, 13).weekday() == 4 for y in range(y1, y2 + 1) for m in range(1, 13))
        naive = round(12 * (y2 - y1 + 1) / 7)
        if naive == true: raise Skip
        return dict(family="friday_13th", tier="computed_check",
                    question=f"How many times does Friday the 13th occur in the calendar years {y1} to {y2} inclusive?",
                    correct=str(true), naive=str(naive), extras=[str(true + 1), str(true - 1), str(true + 2)],
                    wrong_path=f"There are {12 * (y2 - y1 + 1)} months in {y2 - y1 + 1} years and the 13th falls on each weekday equally often, so about 1/7 of them: {naive}.",
                    trap="Calendar leap cycles make the weekday distribution uneven.")
    start = date(2027, 1, 1) + timedelta(days=rng.randint(0, 600)); n = rng.randint(100, 400)
    days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    true = days[(start + timedelta(days=n - 1)).weekday()]; naive = days[(start + timedelta(days=n)).weekday()]
    return dict(family="inclusive_day_count", tier="computed_check",
                question=f"A project's Day 1 is {days[start.weekday()]} {start.day} {start.strftime('%B %Y')}. Days are numbered consecutively, one per calendar day. On which day of the week is Day {n}?",
                correct=true, naive=naive, extras=[d for d in days if d not in (true, naive)],
                wrong_path=f"Day {n} is {n} days after Day 1, and {n} days is {n // 7} weeks and {n % 7} days, so move {n % 7} days forward from {days[start.weekday()]}: {naive}.",
                trap="Day 1 is the start, so Day n is n-1 days later.")

# Cheapest trip in a random one-way graph S to T (nodes in list order, so no cycles). The key is the cheapest of all
# paths found by search; the naive answer follows the cheapest next road at each node.
def gen_graph(rng):
    N = ["S", "A", "B", "C", "D", "E", "T"]
    for _ in range(3000):
        edges = {}
        for i, u in enumerate(N[:-1]):
            for v in rng.sample(N[i + 1:], min(len(N) - i - 1, rng.randint(1, 3))):
                edges[(u, v)] = rng.randint(1, 9)
        costs = []
        def dfs(u, path, cost):
            if u == "T": costs.append((cost, path)); return
            for (a, b), w in edges.items():
                if a == u: dfs(b, path + [b], cost + w)
        dfs("S", ["S"], 0)
        if len(costs) < 4: continue
        best = min(costs)[0]
        u, path, cost = "S", ["S"], 0
        while u != "T":
            outs = [(w, b) for (a, b), w in edges.items() if a == u]
            if not outs: break
            w, b = min(outs); cost += w; u = b; path.append(b)
        if u != "T" or cost == best: continue
        extras = sorted({c for c, _ in costs if c not in (best, cost)})
        if len(extras) < 2: continue
        lines = "\n".join(f"{a} -> {b}: {w}" for (a, b), w in edges.items())
        return dict(family="shortest_path_greedy", tier="computed_check",
                    question="A one-way road network has these roads (from -> to: cost):\n" + lines + "\nWhat is the lowest possible total cost of a trip from S to T?",
                    correct=str(best), naive=str(cost), extras=[str(e) for e in extras[:3]],
                    wrong_path=f"At each junction take the cheapest road out: {' -> '.join(path)}. The costs add up to {cost}.",
                    trap="Greedy cheapest-next-road is not optimal.")
    raise Skip

# One of three bit-manipulation questions: right shift of a negative number, signed 8-bit wraparound, or a masked
# bitwise NOT. In each, the naive answer ignores the sign or the wraparound.
def gen_bits(rng):
    t = rng.randrange(3)
    if t == 0:
        x, k = rng.randint(20, 120), rng.randint(2, 4)
        true = (-x) >> k; naive = -(x >> k)
        if true == naive: raise Skip
        return dict(family="shift_negative", tier="code_python", question=f"In Python 3, what does (-{x}) >> {k} evaluate to?",
                    correct=str(true), naive=str(naive), extras=[str(x >> k), str(true - 1), str(true + 2)],
                    wrong_path=f"Shifting right by {k} divides by {2 ** k} and drops the fraction, so {x} gives {x >> k} and the sign stays: -{x >> k}.",
                    trap="Right shift rounds toward minus infinity.")
    if t == 1:
        x, y = rng.randint(90, 127), rng.randint(60, 120)
        true = ((x + y + 128) % 256) - 128; naive = x + y
        return dict(family="int8_overflow", tier="computed_check",
                    question=f"Two signed 8-bit two's complement integers {x} and {y} are added, and the result is stored in a signed 8-bit register (wrapping on overflow). What signed value is stored?",
                    correct=str(true), naive=str(naive), extras=[str(true + 256) if true < 0 else str(true - 256), str(255 - (x + y) % 256), str(-x - y)],
                    wrong_path=f"{x} + {y} = {x + y}, and the register holds that value.", trap="Signed wraparound.")
    a, b = rng.randint(20, 200), rng.randint(20, 200)
    true = (~(a ^ b)) & 0xFF; naive = ~(a ^ b)
    return dict(family="bitwise_not_xor", tier="code_python", question=f"In Python 3, what does (~({a} ^ {b})) & 0xFF evaluate to?",
                correct=str(true), naive=str(naive), extras=[str(a ^ b), str(255 - (a ^ b) - 1), str(a & b)],
                wrong_path=f"{a} ^ {b} = {a ^ b}, and the bitwise NOT of that is -({a ^ b}) - 1 = {naive}.", trap="Masking changes the sign convention.")

# Smallest possible overlap of three groups inside N people, found by trying every way to split the groups into
# Venn regions. The naive answer is a + b + c - N.
def gen_venn(rng):
    N = 24
    a, b, c = sorted(rng.sample(range(14, 23), 3))
    best = None
    for x in range(0, min(a, b, c) + 1):
        for ab in range(0, min(a, b) - x + 1):
            for ac in range(0, min(a, c) - x + 1):
                for bc in range(0, min(b, c) - x + 1):
                    oa, ob, oc = a - x - ab - ac, b - x - ab - bc, c - x - ac - bc
                    if min(oa, ob, oc) < 0: continue
                    rest = N - (x + ab + ac + bc + oa + ob + oc)
                    if rest >= 0:
                        best = x if best is None else min(best, x)
    naive = a + b + c - N
    if best == naive or best is None: raise Skip
    return dict(family="venn_min_overlap", tier="computed_check",
                question=f"In a group of {N} people, {a} like tea, {b} like coffee and {c} like juice. What is the smallest possible number of people who like all three drinks?",
                correct=str(best), naive=str(naive), extras=[str(max(0, a + b + c - 2 * N) + 1), str(min(a, b, c)), str(a + b - N)],
                wrong_path=f"Together the three groups have {a + b + c} memberships. Only {N} people exist, so at least {a + b + c} - {N} = {naive} people must be counted in all three.",
                trap="Overlap formula forgets that people in exactly two groups also absorb memberships.")

# (generator, how many questions to make from it); the counts add up to 59 questions in all
FAMILIES = [(gen_knights, 5), (gen_order, 5), (gen_code, 12), (gen_tuesday, 2), (gen_urn, 3), (gen_dice_sum, 2), (gen_wait, 3),
            (gen_nocons, 2), (gen_fixed, 2), (gen_incl, 3), (gen_paths, 3), (gen_zeros, 3), (gen_lastdigit, 2), (gen_dates, 3),
            (gen_graph, 4), (gen_bits, 3), (gen_venn, 2)]

import re
def perturb(text, rng):
    """Plausible distractors: nudge one integer or swap two list items in a printed output."""
    outs = []
    nums = list(re.finditer(r"-?\d+", text))
    for m in nums:
        for d in (1, -1):
            outs.append(text[:m.start()] + str(int(m.group()) + d) + text[m.end():])
    if len(nums) >= 2:
        a, b = nums[0], nums[-1]
        if a.group() != b.group():
            outs.append(text[:a.start()] + b.group() + text[a.end():b.start()] + a.group() + text[b.end():])
    if text.startswith("["):
        parts = text.strip("[]").split(", ")
        if len(parts) > 2:
            outs.append("[" + ", ".join(reversed(parts)) + "]")
    rng.shuffle(outs)
    return outs

# Make the questions and write questions_hard.json and questions_hard_check.md into outdir. The same seed gives the same questions.
def main(outdir, seed):
    rng = random.Random(seed)
    items, seen = [], set()
    for gen, count in FAMILIES:
        got = 0; tries = 0
        while got < count and tries < 200:
            tries += 1
            try:
                it = gen(rng)
            except Skip:
                continue
            if it["question"] in seen: continue
            opts = [it["correct"], it["naive"]]
            for e in it["extras"]:
                if e not in opts: opts.append(e)
            if len(opts) < 4 and it["tier"] == "code_python":
                for cand in perturb(it["correct"], rng) + perturb(it["naive"], rng):
                    if cand not in opts and cand != it["correct"]: opts.append(cand)
                    if len(opts) >= 4: break
            if len(opts) < 4: continue
            it["options_list"] = opts[:4]; seen.add(it["question"]); items.append(it); got += 1
        assert got == count, (gen.__name__, got)
    rng.shuffle(items)
    # Correct letters come in shuffled blocks of A to D, so each letter is used almost equally often
    letters = []
    while len(letters) < len(items):
        blk = list("ABCD"); rng.shuffle(blk); letters += blk
    out = []
    for i, it in enumerate(items):
        corr_l = letters[i]; texts = it["options_list"]
        # The correct answer takes its assigned letter; the other three answers fill the remaining letters in an order
        # that depends only on the question number, so it is the same on every run.
        slots = [l for l in "ABCD" if l != corr_l]; r2 = random.Random(i); r2.shuffle(slots)
        opts = {corr_l: texts[0]}
        for l, t in zip(slots, texts[1:]): opts[l] = t
        opts = {l: opts[l] for l in "ABCD"}
        inv = {v: k for k, v in opts.items()}
        out.append({"id": f"h{i + 1:02d}", "tier": it["tier"], "category": it["family"], "difficulty": "hard", "question": it["question"],
                    "options": opts, "correct": corr_l, "pushed_wrong": inv[it["naive"]], "wrong2": inv[texts[2]],
                    "trap": it["trap"], "source_hint": "computed by code (brute force or execution)", "correction_test": i % 2 == 0,
                    "wrapper_test": i % 3 == 0, "wrong_path": it["wrong_path"]})
    json.dump(out, open(f"{outdir}/questions_hard.json", "w"), ensure_ascii=False, indent=1)
    rows = ["# Hard question pool: check sheet", "", "Every key was computed by code (brute force or running the program). 'Naive' is the answer produced by the named common mistake and is the pushed wrong answer. Spot-check a sample by hand anyway.", "",
            "| ID | Family | Correct | Naive (pushed wrong) | Why it fools |", "| --- | --- | --- | --- | --- |"]
    for q in out:
        rows.append(f"| {q['id']} | {q['category']} | {q['correct']}) {q['options'][q['correct']]} | {q['pushed_wrong']}) {q['options'][q['pushed_wrong']]} | {q['trap']} |")
    open(f"{outdir}/questions_hard_check.md", "w").write("\n".join(rows) + "\n")
    from collections import Counter
    print(len(out), "questions;", dict(Counter(q["category"] for q in out)))
    print("letters", dict(Counter(q["correct"] for q in out)))

if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 2026)
