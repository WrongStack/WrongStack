use std::{
    sync::{Condvar, Mutex, PoisonError},
    time::{Duration, Instant},
};

const ACTIVE: Duration = Duration::from_millis(16);
const IDLE_LIMIT: Duration = Duration::from_millis(96);
// A busy shell can take noticeably longer than a frame to consume the input and echo it.
const INPUT_WINDOW: Duration = Duration::from_secs(1);

pub(crate) struct PollPace {
    interval: Duration,
    interactive_until: Instant,
}

impl PollPace {
    pub(crate) fn new() -> Self {
        Self {
            interval: ACTIVE,
            interactive_until: Instant::now(),
        }
    }

    pub(crate) fn input(&mut self, now: Instant) {
        self.interval = ACTIVE;
        self.interactive_until = now + INPUT_WINDOW;
    }

    pub(crate) fn after_read(&mut self, now: Instant, output: bool, backlog: bool) -> Duration {
        if backlog || output || now < self.interactive_until {
            self.interval = ACTIVE;
            return if backlog { Duration::ZERO } else { ACTIVE };
        }
        let delay = self.interval;
        self.interval = (delay * 2).min(IDLE_LIMIT);
        delay
    }
}

struct Signal {
    ready: bool,
    input: bool,
    closed: bool,
}

/// One terminal reader waits for its poll deadline or for the window to signal it.
pub(crate) struct StreamControl {
    pub(crate) id: String,
    signal: Mutex<Signal>,
    changed: Condvar,
}

impl StreamControl {
    pub(crate) fn new(id: String) -> Self {
        Self {
            id,
            signal: Mutex::new(Signal {
                ready: true,
                input: false,
                closed: false,
            }),
            changed: Condvar::new(),
        }
    }

    pub(crate) fn wait_to_read(&self, deadline: Instant) -> Option<bool> {
        let mut signal = self.signal.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if signal.closed {
                return None;
            }
            if !signal.ready {
                // No read-ahead while xterm owns an unacknowledged chunk.
                signal = self
                    .changed
                    .wait(signal)
                    .unwrap_or_else(PoisonError::into_inner);
                continue;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if signal.input || remaining.is_zero() {
                return Some(std::mem::take(&mut signal.input));
            }
            (signal, _) = self
                .changed
                .wait_timeout(signal, remaining)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    pub(crate) fn chunk_sent(&self) {
        self.signal
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .ready = false;
    }

    pub(crate) fn acknowledge(&self) {
        self.signal
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .ready = true;
        self.changed.notify_one();
    }

    pub(crate) fn input(&self) {
        self.signal
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .input = true;
        self.changed.notify_one();
    }

    pub(crate) fn stop(&self) {
        self.signal
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .closed = true;
        self.changed.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quiet_terminal_uses_fewer_host_reads_without_starving_background_output() {
        let mut pace = PollPace::new();
        let start = Instant::now();
        let end = start + Duration::from_secs(2);
        let mut reads = 0;
        let mut now = start;
        while now < end {
            let delay = pace.after_read(now, false, false);
            assert!(delay > Duration::ZERO && delay <= Duration::from_millis(96));
            reads += 1;
            now += delay;
        }
        assert_eq!(pace.after_read(now, true, true), Duration::ZERO);
        assert_eq!(pace.after_read(now, true, false), ACTIVE);
        assert_eq!(reads, 23, "{reads} empty host reads in 2 seconds");
    }

    #[test]
    fn typing_restores_fast_reads_even_before_the_first_echo() {
        let mut pace = PollPace::new();
        let now = Instant::now();
        for _ in 0..5 {
            pace.after_read(now, false, false);
        }
        assert_eq!(pace.after_read(now, false, false), IDLE_LIMIT);
        pace.input(now);
        for ms in [0, 16, 150, 300, 500, 516, 750, 766] {
            assert_eq!(
                pace.after_read(now + Duration::from_millis(ms), false, false),
                ACTIVE
            );
        }
        assert_eq!(pace.after_read(now + INPUT_WINDOW, false, false), ACTIVE);
        assert_eq!(
            pace.after_read(now + INPUT_WINDOW, false, false),
            ACTIVE * 2
        );
    }

    #[test]
    fn queued_input_wakes_an_idle_reader_and_survives_backpressure() {
        let reader = StreamControl::new("fixture".into());
        reader.chunk_sent();
        reader.input();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                tx.send(reader.wait_to_read(Instant::now() + Duration::from_secs(10)))
                    .unwrap()
            });
            assert!(rx.recv_timeout(Duration::from_millis(25)).is_err());
            reader.acknowledge();
            let result = rx.recv_timeout(Duration::from_secs(2));
            reader.stop();
            assert_eq!(result.unwrap(), Some(true));
        });
    }

    #[test]
    fn closing_releases_a_reader_even_when_xterm_never_acknowledges() {
        let reader = StreamControl::new("fixture".into());
        assert_eq!(reader.id, "fixture");
        reader.chunk_sent();
        reader.stop();
        assert_eq!(
            reader.wait_to_read(Instant::now() + Duration::from_secs(10)),
            None
        );
    }
}
