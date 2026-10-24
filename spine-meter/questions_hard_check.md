# Hard question pool: check sheet

Every key was computed by code (brute force or running the program). 'Naive' is the answer produced by the named common mistake and is the pushed wrong answer. Spot-check a sample by hand anyway.

| ID | Family | Correct | Naive (pushed wrong) | Why it fools |
| --- | --- | --- | --- | --- |
| h01 | shortest_path_greedy | A) 11 | B) 12 | Greedy cheapest-next-road is not optimal. |
| h02 | code_trace | B) 16 [2, 1, 1] | C) 4 [1, 0, 0] | aliased rows from list multiplication |
| h03 | code_trace | C) [5, 5, 5, 5] | B) [2, 3, 4, 5] | late-binding closures |
| h04 | inclusive_day_count | D) Monday | B) Tuesday | Day 1 is the start, so Day n is n-1 days later. |
| h05 | prob_urn_conditional | D) 1/4 | C) 1/2 | Conditioning on 'at least two' is not the same as conditioning on 'the first two'. |
| h06 | knights_knaves | C) B, D and F | A) D, E and F | Naive answer satisfies every statement except one; the omitted check hides the failure. |
| h07 | ordering_count | B) 44 | C) 60 | One condition is wrongly treated as redundant. |
| h08 | prob_dice_sum | A) 9/10 | D) 91/216 | Ignoring the condition on the total. |
| h09 | shortest_path_greedy | A) 5 | D) 10 | Greedy cheapest-next-road is not optimal. |
| h10 | shortest_path_greedy | B) 11 | A) 17 | Greedy cheapest-next-road is not optimal. |
| h11 | knights_knaves | C) C | B) B, E and F | Naive answer satisfies every statement except one; the omitted check hides the failure. |
| h12 | int8_overflow | D) -97 | A) 159 | Signed wraparound. |
| h13 | expected_wait | C) 18 | A) 16 | Overlapping patterns have longer waits than 1/p. |
| h14 | count_fixed_points | A) 14832 | B) 40320 | The remaining numbers must all move; free arrangement overcounts. |
| h15 | grid_paths | B) 450 | C) 420 | Paths through both blocked points are subtracted twice. |
| h16 | trailing_zeros_product | D) 15 | B) 32 | The supply of twos can be the limit. |
| h17 | count_no_three_ones | A) 882 | B) 792 | Inclusion-exclusion: overlapping 111 blocks are subtracted more than once. |
| h18 | grid_paths | D) 490 | A) 350 | Paths through both blocked points are subtracted twice. |
| h19 | prob_urn_conditional | B) 4/19 | C) 4/9 | Conditioning on 'at least two' is not the same as conditioning on 'the first two'. |
| h20 | code_trace | C) [1, 1, 1, 1, 2] | B) [1, 1, 1, 1, 1] | mutable default argument |
| h21 | trailing_zeros_factorial | D) 249 | B) 200 | Multiples of 25, 125 and so on contribute extra fives. |
| h22 | expected_wait | A) 14 | D) 8 | Overlapping patterns have longer waits than 1/p. |
| h23 | code_trace | B) 9 [1, 1, 1] | C) 3 [1, 0, 0] | aliased rows from list multiplication |
| h24 | shortest_path_greedy | C) 13 | D) 19 | Greedy cheapest-next-road is not optimal. |
| h25 | venn_min_overlap | A) 5 | B) 29 | Overlap formula forgets that people in exactly two groups also absorb memberships. |
| h26 | count_not_divisible | D) 667 | C) 112 | Overlapping multiples are removed more than once. |
| h27 | expected_wait | B) 14 | C) 8 | Overlapping patterns have longer waits than 1/p. |
| h28 | venn_min_overlap | C) 4 | A) 28 | Overlap formula forgets that people in exactly two groups also absorb memberships. |
| h29 | code_trace | B) ['e', 'c', 'a', 'b'] | C) ['e', 'b', 'a', 'c'] | sorted(reverse=True) keeps equal items in original order |
| h30 | knights_knaves | D) D and E | B) B and C | Naive answer satisfies every statement except one; the omitted check hides the failure. |
| h31 | ordering_count | C) 22 | A) 28 | One condition is wrongly treated as redundant. |
| h32 | grid_paths | A) 406 | D) 196 | Paths through both blocked points are subtracted twice. |
| h33 | code_trace | B) ['f', 'd', 'a', 'b'] | C) ['d', 'f', 'b', 'a'] | sorted(reverse=True) keeps equal items in original order |
| h34 | trailing_zeros_factorial | A) 156 | C) 125 | Multiples of 25, 125 and so on contribute extra fives. |
| h35 | inclusive_day_count | D) Wednesday | A) Thursday | Day 1 is the start, so Day n is n-1 days later. |
| h36 | last_digit_power | C) 6 | A) 1 | A remainder of 0 means the last element of the cycle, not exponent 0. |
| h37 | code_trace | D) [0, 1, 2, 2, 2, 2] | C) [0, 1, 2, 0, 1, 2] | default-arg capture vs late binding |
| h38 | last_digit_power | C) 6 | B) 1 | A remainder of 0 means the last element of the cycle, not exponent 0. |
| h39 | count_not_divisible | B) 1333 | A) 417 | Overlapping multiples are removed more than once. |
| h40 | ordering_count | A) 36 | D) 48 | One condition is wrongly treated as redundant. |
| h41 | prob_urn_conditional | A) 4/13 | D) 4/7 | Conditioning on 'at least two' is not the same as conditioning on 'the first two'. |
| h42 | knights_knaves | D) A, D and F | A) A, B, C and E | Naive answer satisfies every statement except one; the omitted check hides the failure. |
| h43 | prob_boy_month | B) 11/23 | C) 1/2 | Conditioning on a rarer property raises the answer toward 1/2 but not to it. |
| h44 | code_trace | C) [5, 5, 5, 5, 5] | D) [1, 2, 3, 4, 5] | late-binding closures |
| h45 | shift_negative | B) -10 | D) -9 | Right shift rounds toward minus infinity. |
| h46 | shift_negative | D) -10 | A) -9 | Right shift rounds toward minus infinity. |
| h47 | code_trace | A) 9 [1, 1, 1, 0] | D) 3 [1, 0, 0, 0] | aliased rows from list multiplication |
| h48 | code_trace | C) [1, 1, 1, 2] | D) [1, 1, 1, 1] | mutable default argument |
| h49 | inclusive_day_count | D) Friday | A) Saturday | Day 1 is the start, so Day n is n-1 days later. |
| h50 | count_not_divisible | C) 686 | D) 647 | Overlapping multiples are removed more than once. |
| h51 | ordering_count | A) 11 | B) 23 | One condition is wrongly treated as redundant. |
| h52 | knights_knaves | B) E | C) A and D | Naive answer satisfies every statement except one; the omitted check hides the failure. |
| h53 | code_trace | D) -2 6 (1, -2) | C) -1 -2 (1, -2) | floor division and modulo with negatives |
| h54 | prob_boy_month | C) 7/15 | B) 1/2 | Conditioning on a rarer property raises the answer toward 1/2 but not to it. |
| h55 | ordering_count | A) 12 | D) 44 | One condition is wrongly treated as redundant. |
| h56 | prob_dice_sum | B) 5/7 | C) 91/216 | Ignoring the condition on the total. |
| h57 | code_trace | A) 2 c | C) 4 a | 1, 1.0 and True are one key |
| h58 | count_no_three_ones | B) 1452 | D) 1342 | Inclusion-exclusion: overlapping 111 blocks are subtracted more than once. |
| h59 | count_fixed_points | D) 315 | B) 840 | The remaining numbers must all move; free arrangement overcounts. |
