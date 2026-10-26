/** 只接收这次已经读到、并摘掉负荷、容量、完成情况之后的行。没有数据库连接。 */
export interface SandboxRow {
  id: string;
  at: string;
  note: string;
}

export function runSandbox(rows: readonly SandboxRow[]): { figure: string } {
  return { figure: rows.map((row) => `${row.at} ${row.note}`).join("\n") };
}
