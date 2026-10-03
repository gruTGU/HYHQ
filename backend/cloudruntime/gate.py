"""Single PostgreSQL session gate, with no transparent reconnection or pool."""
import psycopg

LOCK_ID = 0x48594851434C4F55  # HYHQ cloud workers; stable across releases.


class GateUnavailable(RuntimeError):
    pass


class PostgresGate:
    def __init__(self, database, connect=psycopg.connect):
        options = dict(database.get('OPTIONS', {}))
        options.update(connect_timeout=5, application_name='hyhq-cloud-worker-gate',
                       keepalives=1, keepalives_idle=2, keepalives_interval=1,
                       keepalives_count=2, tcp_user_timeout=5000,
                       options='-c statement_timeout=4000')
        self.connection = connect(dbname=database['NAME'], user=database['USER'],
                                  password=database['PASSWORD'], host=database['HOST'],
                                  port=database['PORT'], autocommit=True, **options)
        self.held = False

    def acquire(self):
        if self.held:
            raise GateUnavailable('Gate is already held by this supervisor.')
        with self.connection.cursor() as cursor:
            cursor.execute('SELECT pg_try_advisory_lock(%s)', (LOCK_ID,))
            self.held = bool(cursor.fetchone()[0])
        return self.held

    def check(self):
        if not self.held or self.connection.closed:
            raise GateUnavailable('Worker session gate was lost.')
        # Do not call pg_try_advisory_lock here: session locks stack on re-acquire.
        with self.connection.cursor() as cursor:
            cursor.execute('''SELECT EXISTS (SELECT 1 FROM pg_locks
                WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
                AND classid = %s AND objid = %s AND objsubid = 1)''',
                (LOCK_ID >> 32, LOCK_ID & 0xFFFFFFFF))
            if not cursor.fetchone()[0]:
                raise GateUnavailable('Worker session gate was lost.')
        return True

    def close(self):
        self.held = False
        self.connection.close()
