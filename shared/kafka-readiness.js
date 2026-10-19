function createKafkaReadiness({
  Kafka,
  brokers,
  clientId,
}) {
  let pending = null;
  let stopping = false;

  async function probe() {
    const kafka = new Kafka({
      clientId,
      brokers,
      connectionTimeout: 750,
      requestTimeout: 750,
      retry: {
        retries: 0,
      },
      logLevel: 0,
    });

    const admin = kafka.admin();

    try {
      await admin.connect();

      const cluster = await admin.describeCluster();

      return (
        Array.isArray(cluster.brokers) &&
        cluster.brokers.length > 0
      );
    } catch {
      return false;
    } finally {
      try {
        await admin.disconnect();
      } catch {
        // Kết nối probe được đóng sau mỗi lượt kiểm tra.
      }
    }
  }

  function check() {
    if (stopping) {
      return Promise.resolve(false);
    }

    // Các health request đồng thời dùng chung một lượt probe.
    if (!pending) {
      pending = probe().finally(() => {
        pending = null;
      });
    }

    return pending;
  }

  async function close() {
    stopping = true;

    if (pending) {
      await pending;
    }
  }

  return {
    check,
    close,
  };
}

module.exports = createKafkaReadiness;