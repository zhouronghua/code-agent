def fibonacci_recursive(n):
    """Return the nth Fibonacci number (0-indexed) using recursion."""
    if n < 0:
        raise ValueError("n must be non-negative")
    if n == 0:
        return 0
    if n == 1:
        return 1
    return fibonacci_recursive(n - 1) + fibonacci_recursive(n - 2)


def fibonacci_iterative(n):
    """Return the nth Fibonacci number (0-indexed) using iteration."""
    if n < 0:
        raise ValueError("n must be non-negative")
    if n == 0:
        return 0
    if n == 1:
        return 1
    a, b = 0, 1
    for _ in range(2, n + 1):
        a, b = b, a + b
    return b


if __name__ == "__main__":
    # Test that both implementations return the same results for n = 0 through 30
    test_values = list(range(31))  # 0..30 inclusive
    all_match = True
    for n in test_values:
        r = fibonacci_recursive(n)
        i = fibonacci_iterative(n)
        status = "OK" if r == i else "MISMATCH"
        if r != i:
            all_match = False
        print(f"n={n:2d}  recursive={r:8d}  iterative={i:8d}  [{status}]")

    print()
    if all_match:
        print("All tests passed — both implementations agree!")
    else:
        print("Some tests FAILED — implementations disagree!")
