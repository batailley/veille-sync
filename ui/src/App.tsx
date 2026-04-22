import { useState, useEffect, useCallback } from "react";
import {
  Layout,
  Select,
  Table,
  Button,
  Tag,
  Space,
  Typography,
  ConfigProvider,
  Tooltip,
  theme,
  App as AntApp,
} from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  SyncOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  SendOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import type { TableColumnsType, TableRowSelection } from "antd";

const { Header, Content } = Layout;
const { Text, Title } = Typography;

// ─── Types ────────────────────────────────────────────────────────────────────

type FileStatus = "pending" | "processing" | "done" | "error";

interface FileRecord {
  name: string;
  size: number;
  modifiedAt: string;
  status: FileStatus;
  model: string | null;
  processedAt: string | null;
  error: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL_OPTIONS = [
  { value: "gemini", label: "Gemini 2.5 Flash" },
  { value: "claude", label: "Claude Code (local)" },
];

const STATUS_CONFIG: Record<
  FileStatus,
  { color: string; icon: React.ReactNode; label: string }
> = {
  pending: { color: "default", icon: <ClockCircleOutlined />, label: "En attente" },
  processing: { color: "processing", icon: <SyncOutlined spin />, label: "En cours" },
  done: { color: "success", icon: <CheckCircleOutlined />, label: "Traité" },
  error: { color: "error", icon: <CloseCircleOutlined />, label: "Erreur" },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  return `${(bytes / 1024).toFixed(1)} Ko`;
}

// ─── Component ────────────────────────────────────────────────────────────────

function AppContent() {
  const { message } = AntApp.useApp();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [model, setModel] = useState("gemini");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fetchFiles = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/files");
      if (!res.ok) throw new Error(await res.text());
      setFiles(await res.json());
    } catch (err) {
      if (!silent) message.error(`Erreur lors du chargement : ${err}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [message]);

  // Initial load + auto-refresh
  useEffect(() => {
    fetchFiles();
    const t = setInterval(() => fetchFiles(true), 2500);
    return () => clearInterval(t);
  }, [fetchFiles]);

  const handleProcess = async () => {
    if (!selectedKeys.length) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: selectedKeys, model }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { queued } = (await res.json()) as { queued: number };
      message.success(`${queued} fichier${queued > 1 ? "s" : ""} ajouté${queued > 1 ? "s" : ""} à la file`);
      setSelectedKeys([]);
      fetchFiles(true);
    } catch (err) {
      message.error(`Erreur : ${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async () => {
    const errorFiles = selectedKeys.filter(
      (k) => files.find((f) => f.name === k)?.status === "error"
    );
    if (!errorFiles.length) {
      message.warning("Sélectionnez des fichiers en erreur pour les réinitialiser");
      return;
    }
    try {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: errorFiles }),
      });
      message.success(`${errorFiles.length} fichier${errorFiles.length > 1 ? "s" : ""} réinitialisé${errorFiles.length > 1 ? "s" : ""}`);
      setSelectedKeys([]);
      fetchFiles(true);
    } catch (err) {
      message.error(`Erreur : ${err}`);
    }
  };

  const processingCount = files.filter((f) => f.status === "processing").length;
  const doneCount = files.filter((f) => f.status === "done").length;
  const errorCount = files.filter((f) => f.status === "error").length;

  const selectedHasErrors = selectedKeys.some(
    (k) => files.find((f) => f.name === k)?.status === "error"
  );

  const columns: TableColumnsType<FileRecord> = [
    {
      title: "Fichier",
      dataIndex: "name",
      key: "name",
      ellipsis: true,
      render: (name: string) => (
        <Text code style={{ fontSize: 12 }}>
          {name}
        </Text>
      ),
    },
    {
      title: "Taille",
      dataIndex: "size",
      key: "size",
      width: 90,
      align: "right",
      render: (size: number) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {formatSize(size)}
        </Text>
      ),
    },
    {
      title: "Modifié le",
      dataIndex: "modifiedAt",
      key: "modifiedAt",
      width: 130,
      render: (d: string) => (
        <Text style={{ fontSize: 12 }}>{formatDate(d)}</Text>
      ),
    },
    {
      title: "Statut",
      dataIndex: "status",
      key: "status",
      width: 130,
      filters: [
        { text: "En attente", value: "pending" },
        { text: "En cours", value: "processing" },
        { text: "Traité", value: "done" },
        { text: "Erreur", value: "error" },
      ],
      onFilter: (value, record) => record.status === value,
      render: (status: FileStatus, record: FileRecord) => {
        const cfg = STATUS_CONFIG[status];
        return (
          <Tooltip title={record.error ?? undefined} color="red">
            <Tag icon={cfg.icon} color={cfg.color} style={{ cursor: record.error ? "help" : "default" }}>
              {cfg.label}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "Modèle",
      dataIndex: "model",
      key: "model",
      width: 140,
      render: (m: string | null) =>
        m ? <Tag color="blue">{m}</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: "Traité le",
      dataIndex: "processedAt",
      key: "processedAt",
      width: 130,
      render: (d: string | null) =>
        d ? (
          <Text style={{ fontSize: 12 }}>{formatDate(d)}</Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ];

  const rowSelection: TableRowSelection<FileRecord> = {
    selectedRowKeys: selectedKeys,
    onChange: (keys) => setSelectedKeys(keys as string[]),
    getCheckboxProps: (record) => ({
      disabled: record.status === "processing",
    }),
  };

  return (
    <Layout style={{ minHeight: "100vh", background: "#f5f5f5" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          padding: "0 24px",
          background: "#001529",
        }}
      >
        <Title level={4} style={{ color: "#fff", margin: 0, flex: 1 }}>
          Veille Sync
        </Title>
        <Space>
          {processingCount > 0 && (
            <Tag color="processing" icon={<SyncOutlined spin />}>
              {processingCount} en cours
            </Tag>
          )}
          <Tag color="success">{doneCount} traités</Tag>
          {errorCount > 0 && <Tag color="error">{errorCount} erreurs</Tag>}
          <Tag>{files.length} fichiers</Tag>
        </Space>
      </Header>

      <Content style={{ padding: "20px 24px", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {/* Toolbar */}
          <Space
            style={{
              background: "#fff",
              padding: "12px 16px",
              borderRadius: 8,
              width: "100%",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <Space>
              <Text strong>Modèle :</Text>
              <Select
                value={model}
                onChange={setModel}
                options={MODEL_OPTIONS}
                style={{ width: 200 }}
              />
            </Space>

            <Space>
              <Button icon={<ReloadOutlined />} onClick={() => fetchFiles()} loading={loading}>
                Actualiser
              </Button>
              {selectedHasErrors && (
                <Button icon={<UndoOutlined />} onClick={handleReset}>
                  Réinitialiser sélection
                </Button>
              )}
              <Button
                type="primary"
                icon={<SendOutlined />}
                disabled={!selectedKeys.length}
                loading={submitting}
                onClick={handleProcess}
              >
                Envoyer
                {selectedKeys.length > 0 && ` (${selectedKeys.length})`}
              </Button>
            </Space>
          </Space>

          {/* Table */}
          <Table<FileRecord>
            columns={columns}
            dataSource={files}
            rowKey="name"
            rowSelection={rowSelection}
            loading={loading}
            pagination={{ pageSize: 100, hideOnSinglePage: true, showTotal: (t) => `${t} fichiers` }}
            size="small"
            style={{ background: "#fff", borderRadius: 8, overflow: "hidden" }}
            scroll={{ x: 800 }}
          />
        </Space>
      </Content>
    </Layout>
  );
}

export default function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: { colorPrimary: "#1677ff", borderRadius: 6 },
      }}
    >
      <AntApp>
        <AppContent />
      </AntApp>
    </ConfigProvider>
  );
}
