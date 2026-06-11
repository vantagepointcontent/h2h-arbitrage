import sys

with open(sys.argv[1], 'r') as f:
    source = f.read()

lines = source.split('\n')
stack = []  # each entry: (char, line, col)
issues = []

in_string = False
string_char = None
in_template = False
template_depth = 0
in_line_comment = False
in_block_comment = False

for line_idx, line in enumerate(lines):
    lnum = line_idx + 1
    i = 0
    while i < len(line):
        ch = line[i]
        nxt = line[i+1] if i+1 < len(line) else None

        if in_line_comment:
            break  # end of line ends comment

        if in_block_comment:
            if ch == '*' and nxt == '/':
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if not in_string and not in_template:
            if ch == '/' and nxt == '/':
                in_line_comment = True
                i += 2
                continue
            if ch == '/' and nxt == '*':
                in_block_comment = True
                i += 2
                continue

        if in_string:
            if ch == '\\':
                i += 2
                continue
            if ch == string_char:
                in_string = False
                string_char = None
            i += 1
            continue

        if in_template:
            if ch == '\\':
                i += 2
                continue
            if ch == '`':
                if template_depth == 0:
                    in_template = False
                # else nested? not handling perfectly but try
                else:
                    pass  # keep in template
                i += 1
                continue
            if ch == '$' and nxt == '{':
                template_depth += 1
                i += 2
                continue
            if template_depth > 0 and ch == '{':
                template_depth += 1
            if template_depth > 0 and ch == '}':
                template_depth -= 1
            i += 1
            continue

        if ch == '"' or ch == "'" or ch == '`':
            if ch == '`':
                in_template = True
                template_depth = 0
            else:
                in_string = True
                string_char = ch
            i += 1
            continue

        # Track braces
        if ch in '({[':
            stack.append((ch, lnum, i+1))
        elif ch in ')}]':
            if not stack:
                issues.append(f"Unexpected close {ch} at line {lnum}, col {i+1}")
            else:
                last = stack.pop()
                pairs = {'(': ')', '{': '}', '[': ']'}
                if pairs[last[0]] != ch:
                    issues.append(f"Mismatch: opened {last[0]} at line {last[1]}, col {last[2]} but closed with {ch} at line {lnum}, col {i+1}")
        i += 1
    # reset line comments
    in_line_comment = False

print(f"Total lines: {len(lines)}")
print(f"Remaining unclosed parens/braces: {len(stack)}")
if stack:
    print("Last 10 unclosed:")
    for item in stack[-10:]:
        print(f"  {item[0]} at line {item[1]}, col {item[2]} — near: {lines[item[1]-1].strip()[:50]}")
print(f"Issues found: {len(issues)}")
for issue in issues[:20]:
    print(f"  {issue}")
