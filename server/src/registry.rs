//! Open connections of this instance: limits, and close signals (revocation, shutdown).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use uuid::Uuid;

use crate::protocol::ByeReason;

#[derive(Debug, PartialEq, Eq)]
pub enum RegisterError {
    InstanceFull,
    UserFull,
}

struct Conn {
    uid: u64,
    session: String,
    close: watch::Sender<Option<ByeReason>>,
}

#[derive(Default)]
struct Inner {
    conns: HashMap<Uuid, Conn>,
    by_session: HashMap<String, HashSet<Uuid>>,
    by_user: HashMap<u64, usize>,
}

pub struct Registry {
    inner: Mutex<Inner>,
    max_total: usize,
    max_per_user: usize,
}

/// Removes the connection from the registry when dropped (including when an
/// upgrade never completes).
pub struct Registration {
    pub id: Uuid,
    pub close: watch::Receiver<Option<ByeReason>>,
    registry: Arc<Registry>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.registry.remove(self.id);
    }
}

impl Registry {
    pub fn new(max_total: usize, max_per_user: usize) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner::default()),
            max_total,
            max_per_user,
        })
    }

    pub fn register(
        self: &Arc<Self>,
        uid: u64,
        session: &str,
    ) -> Result<Registration, RegisterError> {
        let mut g = self.inner.lock().expect("registry poisoned");
        if g.conns.len() >= self.max_total {
            return Err(RegisterError::InstanceFull);
        }
        let n = g.by_user.get(&uid).copied().unwrap_or(0);
        if n >= self.max_per_user {
            return Err(RegisterError::UserFull);
        }
        let id = Uuid::new_v4();
        let (tx, rx) = watch::channel(None);
        g.conns.insert(
            id,
            Conn {
                uid,
                session: session.to_string(),
                close: tx,
            },
        );
        g.by_session
            .entry(session.to_string())
            .or_default()
            .insert(id);
        *g.by_user.entry(uid).or_default() += 1;
        metrics::gauge!("rt_connections").set(g.conns.len() as f64);
        Ok(Registration {
            id,
            close: rx,
            registry: Arc::clone(self),
        })
    }

    fn remove(&self, id: Uuid) {
        let mut g = self.inner.lock().expect("registry poisoned");
        if let Some(c) = g.conns.remove(&id) {
            if let Some(set) = g.by_session.get_mut(&c.session) {
                set.remove(&id);
                if set.is_empty() {
                    g.by_session.remove(&c.session);
                }
            }
            if let Some(n) = g.by_user.get_mut(&c.uid) {
                *n -= 1;
                if *n == 0 {
                    g.by_user.remove(&c.uid);
                }
            }
        }
        metrics::gauge!("rt_connections").set(g.conns.len() as f64);
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("registry poisoned").conns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Distinct session hashes with at least one open connection.
    pub fn sessions(&self) -> Vec<String> {
        self.inner
            .lock()
            .expect("registry poisoned")
            .by_session
            .keys()
            .cloned()
            .collect()
    }

    /// Asks every connection of a session to close. Returns how many were signalled.
    pub fn close_session(&self, session: &str, reason: ByeReason) -> usize {
        let g = self.inner.lock().expect("registry poisoned");
        let Some(ids) = g.by_session.get(session) else {
            return 0;
        };
        let mut n = 0;
        for c in ids.iter().filter_map(|id| g.conns.get(id)) {
            c.close.send_replace(Some(reason));
            n += 1;
        }
        n
    }

    /// Asks one connection to close (e.g. too slow to receive broadcasts).
    pub fn close_conn(&self, id: Uuid, reason: ByeReason) {
        let g = self.inner.lock().expect("registry poisoned");
        if let Some(c) = g.conns.get(&id) {
            c.close.send_replace(Some(reason));
        }
    }

    pub fn close_all(&self, reason: ByeReason) {
        let g = self.inner.lock().expect("registry poisoned");
        for c in g.conns.values() {
            c.close.send_replace(Some(reason));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_and_cleanup() {
        let r = Registry::new(3, 2);
        let a = r.register(1, "s1").unwrap();
        let b = r.register(1, "s1").unwrap();
        assert_eq!(r.register(1, "s2").err(), Some(RegisterError::UserFull));
        let c = r.register(2, "s3").unwrap();
        assert_eq!(r.register(3, "s4").err(), Some(RegisterError::InstanceFull));
        assert_eq!(r.len(), 3);
        drop(a);
        assert_eq!(r.len(), 2);
        assert!(r.register(1, "s1").is_ok()); // slot freed for user 1 (and dropped immediately)
        drop(b);
        drop(c);
        assert!(r.is_empty());
        assert!(r.sessions().is_empty());
    }

    #[test]
    fn close_signals() {
        let r = Registry::new(10, 10);
        let a = r.register(1, "s1").unwrap();
        let b = r.register(1, "s1").unwrap();
        let c = r.register(2, "s2").unwrap();
        assert_eq!(r.close_session("s1", ByeReason::Revoked), 2);
        assert_eq!(*a.close.borrow(), Some(ByeReason::Revoked));
        assert_eq!(*b.close.borrow(), Some(ByeReason::Revoked));
        assert_eq!(*c.close.borrow(), None);
        assert_eq!(r.close_session("nope", ByeReason::Revoked), 0);
        r.close_all(ByeReason::Shutdown);
        assert_eq!(*c.close.borrow(), Some(ByeReason::Shutdown));
    }
}
