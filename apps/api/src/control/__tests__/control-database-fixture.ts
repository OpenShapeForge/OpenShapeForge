// SPDX-License-Identifier: BUSL-1.1
import { DummyDriver, type CompiledQuery, type QueryResult } from "kysely";
import { rlsBypassToken } from "../../db/rls-bypass.js";

/** Empty control registry, with the same explicit bypass attestation as the database. */
export class ControlDatabaseFixtureDriver extends DummyDriver {
  override async acquireConnection() {
    const connection = await super.acquireConnection();
    const execute = connection.executeQuery.bind(connection);
    let setting: unknown = "false";
    connection.executeQuery = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      if (query.sql.includes("set_config('app.bypass_rls'")) setting = query.parameters[0];
      if (query.sql === "select app.bypass_rls() as accepted") return { rows: [{ accepted: setting === rlsBypassToken() } as R] };
      return execute<R>(query);
    };
    return connection;
  }
}
